import { getDb } from "../db/database.ts";
import { verifyConnectedAccount } from "./composio-client.ts";
import {
  consumeBrokerCorrelation,
  readBrokerCorrelation,
  type BrokerCorrelation,
} from "./oauth-broker-correlation.ts";
import { safeOAuthCorrelationId } from "./oauth-engine.ts";
import { OAUTH_PROVIDERS } from "./provider-registry.ts";

export interface BrokerCallbackResult {
  success: boolean;
  message: string;
  flowId?: string;
  connectionId?: string;
  errorCode?: string;
  postMessageOrigin?: string;
}

interface BrokerCallbackOptions {
  connectionId?: string;
  requestedFlowId?: string;
  validateFlow: (flowId: string, providerId: string) => void;
  completeFlow: (flowId: string, providerId: string) => void;
}

function correlatedResult(
  correlation: BrokerCorrelation,
  result: Omit<BrokerCallbackResult, "flowId" | "connectionId" | "postMessageOrigin">
): BrokerCallbackResult {
  return {
    ...result,
    flowId: correlation.flowId,
    connectionId: correlation.connectionId,
    postMessageOrigin: correlation.postMessageOrigin,
  };
}

function sameCorrelation(left: BrokerCorrelation, right: BrokerCorrelation): boolean {
  return (
    left.flowId === right.flowId &&
    left.connectionId === right.connectionId &&
    left.providerId === right.providerId &&
    left.postMessageOrigin === right.postMessageOrigin
  );
}

export async function processBrokerCallback(
  options: BrokerCallbackOptions
): Promise<BrokerCallbackResult> {
  const correlation = options.connectionId ? readBrokerCorrelation(options.connectionId) : null;
  if (
    !correlation ||
    !options.requestedFlowId ||
    options.requestedFlowId !== correlation.flowId ||
    options.connectionId !== correlation.connectionId
  ) {
    return {
      success: false,
      message: "Broker OAuth callback could not be validated.",
      flowId: correlation?.flowId,
      connectionId: safeOAuthCorrelationId(options.connectionId),
      errorCode: "oauth_broker_callback_invalid",
      postMessageOrigin: correlation?.postMessageOrigin,
    };
  }

  const provider = OAUTH_PROVIDERS.find(
    (item) => item.id === correlation.providerId && item.method === "composio"
  );
  if (!provider?.composioToolkit) {
    return correlatedResult(correlation, {
      success: false,
      message: "Broker OAuth callback could not be validated.",
      errorCode: "oauth_broker_callback_invalid",
    });
  }

  try {
    options.validateFlow(correlation.flowId, correlation.providerId);
  } catch {
    return correlatedResult(correlation, {
      success: false,
      message: "OAuth setup is no longer active.",
      errorCode: "oauth_flow_inactive",
    });
  }

  let remotelyVerified = false;
  try {
    remotelyVerified = await verifyConnectedAccount(
      correlation.connectionId,
      provider.composioToolkit
    );
  } catch {
    // Remote failures are retryable and must not claim durable correlation.
  }
  if (!remotelyVerified) {
    return correlatedResult(correlation, {
      success: false,
      message: "Broker account could not be verified as active yet.",
      errorCode: "oauth_broker_account_unverified",
    });
  }

  try {
    getDb()
      .transaction(() => {
        const consumed = consumeBrokerCorrelation(correlation.connectionId);
        if (!consumed || !sameCorrelation(consumed, correlation)) {
          throw new Error("Broker OAuth correlation changed");
        }
        options.completeFlow(consumed.flowId, consumed.providerId);
      })
      .immediate();
  } catch {
    return correlatedResult(correlation, {
      success: false,
      message: "OAuth setup is no longer active.",
      errorCode: "oauth_flow_inactive",
    });
  }

  return correlatedResult(correlation, { success: true, message: "Account Connected!" });
}
