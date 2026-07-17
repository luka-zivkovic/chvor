import type {
  IntegrationSetupCredentialSubmissionRequest,
  IntegrationSetupDiscoveryRequest,
  IntegrationSetupDuplicateDecisionRequest,
  IntegrationSetupFlowSnapshot,
  IntegrationSetupInstructionAcknowledgementRequest,
  IntegrationSetupStartRequest,
} from "@chvor/shared";

type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createIntegrationSetupApi(request: JsonRequest) {
  return {
    start: (body: IntegrationSetupStartRequest) =>
      request<IntegrationSetupFlowSnapshot>("/integration-setup", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    list: () => request<IntegrationSetupFlowSnapshot[]>("/integration-setup"),
    get: (flowId: string) =>
      request<IntegrationSetupFlowSnapshot>(`/integration-setup/${encodeURIComponent(flowId)}`),
    submitCredentials: (flowId: string, body: IntegrationSetupCredentialSubmissionRequest) =>
      request<IntegrationSetupFlowSnapshot>(
        `/integration-setup/${encodeURIComponent(flowId)}/credentials`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    acknowledgeInstruction: (
      flowId: string,
      body: IntegrationSetupInstructionAcknowledgementRequest
    ) =>
      request<IntegrationSetupFlowSnapshot>(
        `/integration-setup/${encodeURIComponent(flowId)}/acknowledge`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    confirm: (flowId: string, body: IntegrationSetupDuplicateDecisionRequest) =>
      request<IntegrationSetupFlowSnapshot>(
        `/integration-setup/${encodeURIComponent(flowId)}/confirm`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    discovery: (flowId: string, body: IntegrationSetupDiscoveryRequest) =>
      request<IntegrationSetupFlowSnapshot>(
        `/integration-setup/${encodeURIComponent(flowId)}/discovery`,
        { method: "POST", body: JSON.stringify(body) }
      ),
    cancel: (flowId: string, revision: number) =>
      request<IntegrationSetupFlowSnapshot>(
        `/integration-setup/${encodeURIComponent(flowId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ schemaVersion: 1, flowId, revision }),
        }
      ),
  };
}
