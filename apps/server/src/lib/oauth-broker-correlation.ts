import {
  consumeIntegrationSetupSecretEnvelopeByState,
  lookupIntegrationSetupSecretEnvelopeByState,
  type IntegrationSetupSecretEnvelope,
} from "../db/integration-setup-store.ts";
import { safeOAuthCorrelationId } from "./oauth-engine.ts";
import { exactHttpOrigin } from "./oauth-route-helpers.ts";

export interface BrokerCorrelation {
  schemaVersion: 1;
  flowId: string;
  connectionId: string;
  providerId: string;
  postMessageOrigin: string;
}

export function brokerCorrelationPayload(value: BrokerCorrelation): string {
  return JSON.stringify(value);
}

function parseBrokerCorrelation(
  envelope: IntegrationSetupSecretEnvelope | null,
  connectionId: string
): BrokerCorrelation | null {
  if (!envelope || envelope.purpose !== "staged-oauth") return null;
  try {
    const value = JSON.parse(envelope.payload) as Partial<BrokerCorrelation>;
    return value.schemaVersion === 1 &&
      value.flowId === envelope.flowId &&
      safeOAuthCorrelationId(value.flowId) &&
      value.connectionId === connectionId &&
      safeOAuthCorrelationId(value.connectionId) &&
      safeOAuthCorrelationId(value.providerId) &&
      exactHttpOrigin(value.postMessageOrigin) === value.postMessageOrigin
      ? (value as BrokerCorrelation)
      : null;
  } catch {
    return null;
  }
}

/** Read durable callback correlation without claiming its one-time envelope. */
export function readBrokerCorrelation(connectionId: string): BrokerCorrelation | null {
  return parseBrokerCorrelation(
    lookupIntegrationSetupSecretEnvelopeByState(connectionId),
    connectionId
  );
}

/** Claim durable callback correlation inside the caller's completion transaction. */
export function consumeBrokerCorrelation(connectionId: string): BrokerCorrelation | null {
  return parseBrokerCorrelation(
    consumeIntegrationSetupSecretEnvelopeByState(connectionId, "staged-oauth"),
    connectionId
  );
}
