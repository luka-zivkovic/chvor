import type {
  IntegrationSetupFlowSnapshot,
  IntegrationSetupInstructionAcknowledgementRequest,
} from "@chvor/shared";
import { api } from "@/lib/api";

type InstructionContinuationApi = {
  acknowledgeInstruction?: (
    flowId: string,
    body: IntegrationSetupInstructionAcknowledgementRequest
  ) => Promise<IntegrationSetupFlowSnapshot>;
};

function continuationApi(): InstructionContinuationApi {
  return api.integrationSetup as typeof api.integrationSetup & InstructionContinuationApi;
}

/** Compatibility seam for the pending instruction-acknowledgement contract. */
export function canAcknowledgeIntegrationInstruction(): boolean {
  return typeof continuationApi().acknowledgeInstruction === "function";
}

export function acknowledgeIntegrationInstruction(
  flow: IntegrationSetupFlowSnapshot
): Promise<IntegrationSetupFlowSnapshot> | null {
  const stepId = flow.currentStepId;
  const acknowledge = continuationApi().acknowledgeInstruction;
  if (!stepId || !acknowledge) return null;
  return acknowledge(flow.id, {
    schemaVersion: 1,
    flowId: flow.id,
    revision: flow.revision,
    stepId,
  });
}
