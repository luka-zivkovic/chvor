import {
  INTEGRATION_SETUP_LIMITS,
  INTEGRATION_SETUP_SCHEMA_VERSION,
  integrationSetupCredentialSubmissionRequestSchema,
  integrationSetupDiscoveryRequestSchema,
  integrationSetupDuplicateDecisionRequestSchema,
  integrationSetupInstructionAcknowledgementRequestSchema,
  integrationSetupStartRequestSchema,
} from "@chvor/shared";
import { Hono, type Context } from "hono";
import { z, ZodError, type ZodType } from "zod";
import {
  IntegrationSetupFlowExpiredError,
  IntegrationSetupFlowNotFoundError,
  IntegrationSetupIllegalTransitionError,
  IntegrationSetupRevisionConflictError,
} from "../db/integration-setup-store.ts";
import {
  IntegrationSetupCredentialNotFoundError,
  IntegrationSetupManifestNotFoundError,
  IntegrationSetupRequestError,
  acknowledgeIntegrationSetupInstruction,
  cancelIntegrationSetup,
  confirmIntegrationSetupDuplicate,
  getIntegrationSetup,
  listIntegrationSetups,
  startIntegrationSetup,
  submitIntegrationSetupCredentials,
  submitIntegrationSetupDiscovery,
} from "../lib/integration-setup-service.ts";

const routes = new Hono();
const FLOW_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const flowIdSchema = z.string().min(1).max(INTEGRATION_SETUP_LIMITS.id).regex(FLOW_ID_PATTERN);
const cancelRequestSchema = z
  .object({
    schemaVersion: z.literal(INTEGRATION_SETUP_SCHEMA_VERSION),
    flowId: flowIdSchema,
    revision: z.number().int().positive().max(INTEGRATION_SETUP_LIMITS.revision),
  })
  .strict();

routes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

async function parsedJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new SyntaxError("request body must be valid JSON");
  }
  return schema.parse(body);
}

function pathFlowId(c: Context): string {
  return flowIdSchema.parse(c.req.param("id"));
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof IntegrationSetupRevisionConflictError) {
    return c.json(
      {
        error: "Integration setup revision conflict",
        code: "integration_setup_revision_conflict",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
      409
    );
  }
  if (error instanceof IntegrationSetupManifestNotFoundError) {
    return c.json({ error: "Integration manifest not found", code: error.code }, 404);
  }
  if (error instanceof IntegrationSetupCredentialNotFoundError) {
    return c.json({ error: "Integration credential not found", code: error.code }, 404);
  }
  if (error instanceof IntegrationSetupFlowNotFoundError) {
    return c.json(
      { error: "Integration setup flow not found", code: "integration_setup_flow_not_found" },
      404
    );
  }
  if (error instanceof IntegrationSetupFlowExpiredError) {
    return c.json(
      { error: "Integration setup flow expired", code: "integration_setup_flow_expired" },
      400
    );
  }
  if (error instanceof IntegrationSetupRequestError) {
    return c.json({ error: "Invalid integration setup request", code: error.code }, 400);
  }
  if (
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof IntegrationSetupIllegalTransitionError
  ) {
    return c.json(
      { error: "Invalid integration setup request", code: "invalid_integration_setup_request" },
      400
    );
  }
  throw error;
}

routes.post("/", async (c) => {
  try {
    const request = await parsedJson(c, integrationSetupStartRequestSchema);
    return c.json({ data: startIntegrationSetup(request) }, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.get("/", (c) => {
  try {
    return c.json({ data: listIntegrationSetups() });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.get("/:id", (c) => {
  try {
    return c.json({ data: getIntegrationSetup(pathFlowId(c)) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.post("/:id/credentials", async (c) => {
  try {
    const flowId = pathFlowId(c);
    const request = await parsedJson(c, integrationSetupCredentialSubmissionRequestSchema);
    return c.json({ data: submitIntegrationSetupCredentials(flowId, request) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.post("/:id/confirm", async (c) => {
  try {
    const flowId = pathFlowId(c);
    const request = await parsedJson(c, integrationSetupDuplicateDecisionRequestSchema);
    return c.json({ data: confirmIntegrationSetupDuplicate(flowId, request) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.post("/:id/acknowledge", async (c) => {
  try {
    const flowId = pathFlowId(c);
    const request = await parsedJson(c, integrationSetupInstructionAcknowledgementRequestSchema);
    return c.json({ data: acknowledgeIntegrationSetupInstruction(flowId, request) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.post("/:id/discovery", async (c) => {
  try {
    const flowId = pathFlowId(c);
    const request = await parsedJson(c, integrationSetupDiscoveryRequestSchema);
    return c.json({ data: submitIntegrationSetupDiscovery(flowId, request) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

routes.post("/:id/cancel", async (c) => {
  try {
    const flowId = pathFlowId(c);
    const request = await parsedJson(c, cancelRequestSchema);
    return c.json({ data: cancelIntegrationSetup(flowId, request) });
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default routes;
