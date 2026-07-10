import type { CoreMessage } from "ai";
import type { ActorType, ExecutionEvent, MediaArtifact, SecurityActionContext, SecurityActionKind } from "@chvor/shared";
import { logError } from "../error-logger.ts";
import { mcpManager } from "../mcp-manager.ts";
import { callNativeTool, getNativeToolTarget, isNativeTool } from "../native-tools.ts";
import { loadTools, reloadAll } from "../capability-loader.ts";
import { beginAction, failAction, finishAction } from "../event-bus.ts";
import { PC_INTERNAL_MEDIA_TOOLS, extractMedia, findCredentialForUrl, publicMedia, sanitizeResultForLLM } from "./tool-result.ts";
import { analyzeAction, ensureBuiltinAnalyzersRegistered, isBlockHighRiskEnabled, isVerdictEventVerbose } from "../security-analyzer.ts";
import { appendAudit } from "../../db/audit-log-store.ts";
import { recordToolOutcome } from "../tool-graph.ts";
import { getLatestCheckpointForSession } from "../../db/checkpoint-store.ts";
import { isHITLEnabled, requestNativeApproval } from "../approval-gate-hitl.ts";

type EventEmitter = (event: ExecutionEvent) => void;

type ToolCall = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
};

type ToolResult = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  media?: MediaArtifact[];
};

type ToolSeverity = (toolName: string) => "low" | "medium" | "high";

type ToolCallOptions = {
  sessionId?: string;
  originClientId?: string;
  channelType?: string;
  channelId?: string;
  loopId?: string;
  actor?: { type: ActorType; id: string | null };
};

export async function runToolCalls(args: {
  toolCalls: ToolCall[];
  currentMessages: CoreMessage[];
  emit: EventEmitter;
  options?: ToolCallOptions;
  bagScope: { allowedCredentialTypes?: Set<string> };
  preferredUsageContext: string[];
  hitlAllowTurn: Set<string>;
  toolSeverity: ToolSeverity;
  collectEmotionOutcomes: boolean;
}): Promise<{
  toolResults: ToolResult[];
  roundToolOutcomes: Array<{ toolName: string; success: boolean }>;
  toolOutcomeResults: Array<{ success: boolean; severity: "low" | "medium" | "high" }>;
}> {
  const {
    toolCalls,
    currentMessages,
    emit,
    options,
    bagScope,
    preferredUsageContext,
    hitlAllowTurn,
    toolSeverity,
    collectEmotionOutcomes,
  } = args;
  const emotionEngine = collectEmotionOutcomes;
  const hitlKey = (kind: string, toolName: string): string =>
    `${options?.sessionId ?? ""}::${kind}::${toolName}`;
  const toolOutcomeResults: Array<{ success: boolean; severity: "low" | "medium" | "high" }> = [];
  // Process each tool call
  const toolResults: Array<{
    toolCallId: string;
    toolName: string;
    result: unknown;
    media?: MediaArtifact[];
  }> = [];

  // Attribution for typed audit events — default to session actor when unspecified
  const actorCtx = {
    sessionId: options?.sessionId ?? null,
    actorType: (options?.actor?.type ?? "session") as ActorType,
    actorId: options?.actor?.id ?? options?.sessionId ?? null,
  };

  // Lazy-init builtin security analyzers (idempotent).
  ensureBuiltinAnalyzersRegistered();

  // Per-turn graph state: track which tools have already succeeded so we can
  // form Hebbian co-activation edges between tools used together.
  const turnSuccessSet = new Set<string>();

  // Phase D3 — per-round tool outcomes for the checkpoint snapshot. Resets
  // each round so a snapshot only reflects calls made in *this* round.
  const roundToolOutcomes: Array<{ toolName: string; success: boolean }> = [];

  /**
   * Record a tool outcome in the Cognitive Tool Graph and emit a canvas
   * event. Called after every tool call (success or failure) on every
   * branch — native, synthesized, MCP. Best-effort: swallows errors so a
   * graph-store hiccup never breaks the actual tool result.
   */
  function observeToolOutcome(toolName: string, success: boolean): void {
    roundToolOutcomes.push({ toolName, success });
    try {
      const peers = success ? Array.from(turnSuccessSet).filter((t) => t !== toolName) : [];
      const result = recordToolOutcome({
        toolName,
        success,
        recentlySucceeded: peers,
      });
      if (success) turnSuccessSet.add(toolName);
      emit({
        type: "tool.graph.observed",
        data: {
          toolName,
          success,
          strengthBefore: result.before.strength,
          strengthAfter: result.after.strength,
          successCount: result.after.successCount,
          failureCount: result.after.failureCount,
          edgesBumped: result.edgesBumped,
          inTrialBoost: result.after.trialBoostRemaining > 0,
        },
      });
    } catch (err) {
      console.warn(
        "[orchestrator] tool-graph observe failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Run all registered security analyzers over a tool call. Emits a
   * security.verdict canvas event for HIGH-risk (or always when verbose
   * mode is on).
   *
   * Policy ladder when verdict is HIGH-risk:
   *   1. HITL on + sessionId present (Phase D4) → request user approval.
   *      If user has already chosen "allow-session" earlier in this turn,
   *      skip the prompt and run the tool. Denial / timeout → synthetic
   *      error to the LLM, identical shape to the static-block path.
   *   2. HITL off OR no sessionId → fall back to `block-high-risk`
   *      static behavior (synthetic error, no prompt).
   */
  async function runSecurityGate(
    tc: { toolCallId: string; toolName: string; args: Record<string, unknown> },
    kind: SecurityActionKind,
    extras: { toolId?: string; endpointName?: string; group?: import("@chvor/shared").ToolGroupId } = {},
  ): Promise<
    | { allowed: true }
    | { allowed: false; result: { toolCallId: string; toolName: string; result: unknown } }
  > {
    const ctx: SecurityActionContext = {
      kind,
      toolName: tc.toolName,
      toolId: extras.toolId,
      endpointName: extras.endpointName,
      group: extras.group,
      args: tc.args,
      sessionId: options?.sessionId,
      actorType: actorCtx.actorType,
    };

    const verdict = await analyzeAction(ctx);
    const isHigh = verdict.risk === "high";
    const canPromptHITL = isHigh && isHITLEnabled() && Boolean(options?.sessionId);
    const cachedSessionAllow =
      isHigh && hitlAllowTurn.has(hitlKey(kind, tc.toolName));
    const block = isHigh && !canPromptHITL && !cachedSessionAllow && isBlockHighRiskEnabled();

    if (verdict.risk !== "low" || isVerdictEventVerbose()) {
      emit({
        type: "security.verdict",
        data: {
          toolName: tc.toolName,
          kind,
          risk: verdict.risk,
          blocked: block,
          reasons: verdict.verdicts.map((v) => ({
            analyzer: v.analyzer,
            risk: v.risk,
            reason: v.reason,
          })),
        },
      });
    }

    // Path 1: HIGH risk, HITL on, session known, no cached allow yet.
    if (isHigh && canPromptHITL && !cachedSessionAllow) {
      const checkpointId = options?.sessionId
        ? getLatestCheckpointForSession(options.sessionId)?.id ?? null
        : null;
      const reasons = verdict.highest.map((v) => `[${v.analyzer}] ${v.reason}`);
      emit({
        type: "security.approval.requested",
        data: {
          toolName: tc.toolName,
          kind,
          risk: verdict.risk,
          reasons: verdict.highest.map((v) => ({
            analyzer: v.analyzer,
            risk: v.risk,
            reason: v.reason,
          })),
          checkpointId,
        },
      });

      const outcome = await requestNativeApproval({
        sessionId: options?.sessionId ?? null,
        actionId: null,
        toolName: tc.toolName,
        kind,
        args: tc.args,
        risk: verdict.risk,
        reasons,
        checkpointId,
        originClientId: options?.originClientId,
      });

      try {
        appendAudit({
          eventType: outcome.allowed ? "security.approval.allowed" : "security.approval.denied",
          actorType: actorCtx.actorType,
          actorId: actorCtx.actorId,
          resourceType: "tool",
          resourceId: tc.toolName,
          action: outcome.allowed ? "allow" : "deny",
          error: outcome.allowed
            ? null
            : `${outcome.reason}: ${reasons.join(" | ")}`,
        });
      } catch (err) {
        console.warn("[orchestrator] security audit write failed:", err instanceof Error ? err.message : String(err));
      }

      if (outcome.allowed) {
        if (outcome.decision === "allow-session") {
          hitlAllowTurn.add(hitlKey(kind, tc.toolName));
        }
        emit({
          type: "security.approval.resolved",
          data: {
            toolName: tc.toolName,
            kind,
            status: "allowed",
            decision: outcome.decision,
          },
        });
        return { allowed: true };
      }

      emit({
        type: "security.approval.resolved",
        data: {
          toolName: tc.toolName,
          kind,
          status: outcome.reason === "denied" ? "denied" : "expired",
          decision: outcome.record?.decision ?? null,
        },
      });
      const messages = verdict.highest.map((v) => `${v.analyzer}: ${v.reason}`).join("; ");
      const errorPayload = {
        error:
          outcome.reason === "denied"
            ? `User denied the action. Reasons: ${messages}. Continue without this tool.`
            : `Approval prompt timed out (${outcome.reason}). Reasons: ${messages}. Continue without this tool.`,
        security: { risk: verdict.risk, reasons: verdict.highest, approval: outcome.reason },
      };
      if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
      observeToolOutcome(tc.toolName, false);
      return {
        allowed: false,
        result: { toolCallId: tc.toolCallId, toolName: tc.toolName, result: errorPayload },
      };
    }

    // Path 2: cached "allow-session" — skip prompt + audit.
    if (isHigh && cachedSessionAllow) {
      emit({
        type: "security.approval.resolved",
        data: { toolName: tc.toolName, kind, status: "allowed", decision: "allow-session" },
      });
      return { allowed: true };
    }

    // Path 3: classic static block.
    if (block) {
      try {
        appendAudit({
          eventType: "security.blocked",
          actorType: actorCtx.actorType,
          actorId: actorCtx.actorId,
          resourceType: "tool",
          resourceId: tc.toolName,
          action: "deny",
          error: verdict.highest.map((v) => `[${v.analyzer}] ${v.reason}`).join(" | "),
        });
      } catch (err) {
        console.warn("[orchestrator] security audit write failed:", err instanceof Error ? err.message : String(err));
      }

      const messages = verdict.highest.map((v) => `${v.analyzer}: ${v.reason}`).join("; ");
      const errorPayload = {
        error:
          "Action blocked by security policy. " +
          `Reasons: ${messages}. ` +
          "If this was a legitimate request, ask the user to relax the policy or rephrase without dangerous payloads.",
        security: { risk: verdict.risk, reasons: verdict.highest },
      };
      if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
      observeToolOutcome(tc.toolName, false);
      return {
        allowed: false,
        result: {
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: errorPayload,
        },
      };
    }

    return { allowed: true };
  }

  for (const tc of toolCalls) {
    // Handle native (built-in) tools first
    if (isNativeTool(tc.toolName)) {
      const gate = await runSecurityGate(tc, "native");
      if (!gate.allowed) {
        toolResults.push(gate.result);
        continue;
      }
      const target = getNativeToolTarget(tc.toolName);
      // Detect matching API connection BEFORE emitting events so we light up the right node
      let matchedIntegration: { id: string; name: string } | null = null;
      if (tc.toolName === "native__web_request" && tc.args.url) {
        matchedIntegration = findCredentialForUrl(String(tc.args.url));
      }
      if (matchedIntegration) {
        // Route to the connection node instead of web-browse
        emit({
          type: "brain.decision",
          data: { skillId: matchedIntegration.id, capabilityKind: "skill", reason: `Calling ${tc.toolName}` },
        });
        emit({
          type: "skill.invoked",
          data: { nodeId: `api-${matchedIntegration.id}`, skillId: matchedIntegration.id, isApiConnection: true },
        });
      } else {
        emit({
          type: "brain.decision",
          data: {
            ...(target?.kind === "skill" ? { skillId: target.id } : { toolId: target?.id }),
            capabilityKind: target?.kind ?? "tool",
            reason: `Calling ${tc.toolName}`,
          },
        });
        if (target) {
          const nodePrefix = target.kind === "tool" ? "tool" : "skill";
          emit({
            type: target.kind === "tool" ? "tool.invoked" : "skill.invoked",
            data: { nodeId: `${nodePrefix}-${target.id}`, [target.kind === "tool" ? "toolId" : "skillId"]: target.id },
          } as ExecutionEvent);
        }
      }
      const nativeActionHandle = beginAction("native", tc.toolName, tc.args, actorCtx);
      try {
        const latestUserText = (() => {
          for (let i = currentMessages.length - 1; i >= 0; i--) {
            const m = currentMessages[i];
            if (m.role !== "user") continue;
            const c = m.content;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) {
              const text = c.find((p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text");
              if (text && typeof (text as { text?: string }).text === "string") {
                return (text as { text: string }).text;
              }
            }
            return undefined;
          }
          return undefined;
        })();
        const nativeResult = await callNativeTool(tc.toolName, tc.args, {
          sessionId: options?.sessionId,
          emitEvent: emit,
          originClientId: options?.originClientId,
          channelType: options?.channelType,
          channelId: options?.channelId,
          loopId: options?.loopId,
          latestUserText,
          allowedCredentialTypes: bagScope.allowedCredentialTypes
            ? Array.from(bagScope.allowedCredentialTypes)
            : undefined,
          preferredUsageContext,
        });
        const nativeMedia = extractMedia(nativeResult, PC_INTERNAL_MEDIA_TOOLS.has(tc.toolName) ? { internal: true } : undefined);
        const sanitizedNativeResult = sanitizeResultForLLM(nativeResult, nativeMedia);
        const publicNativeMedia = publicMedia(nativeMedia);
        // Persist observation with secret-safe payload for credential tools and without
        // raw internal screenshots for PC-control tools.
        finishAction(
          nativeActionHandle,
          tc.toolName === "native__use_credential"
            ? { content: [{ type: "text", text: "Credential retrieved." }] }
            : sanitizedNativeResult
        );
        if (matchedIntegration) {
          emit({ type: "skill.completed", data: { nodeId: `api-${matchedIntegration.id}`, output: "" } });
        } else if (target) {
          const nodePrefix = target.kind === "tool" ? "tool" : "skill";
          // Never broadcast raw secrets or raw internal screenshots to WS clients.
          const SECRET_TOOLS = new Set(["native__use_credential"]);
          const safeOutput = SECRET_TOOLS.has(tc.toolName)
            ? { content: [{ type: "text", text: "Credential retrieved." }] }
            : sanitizedNativeResult;
          emit({
            type: target.kind === "tool" ? "tool.completed" : "skill.completed",
            data: { nodeId: `${nodePrefix}-${target.id}`, output: safeOutput, ...(publicNativeMedia.length > 0 ? { media: publicNativeMedia } : {}) },
          } as ExecutionEvent);
        }
        if (tc.toolName === "native__create_skill" || tc.toolName === "native__create_workflow") {
          reloadAll();
        }
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: nativeResult,
          ...(nativeMedia.length > 0 ? { media: nativeMedia } : {}),
        });
        if (emotionEngine) toolOutcomeResults.push({ success: true, severity: toolSeverity(tc.toolName) });
        observeToolOutcome(tc.toolName, true);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logError("tool_failure", err, { toolName: tc.toolName, sessionId: options?.sessionId });
        failAction(nativeActionHandle, err);
        if (matchedIntegration) {
          emit({ type: "skill.failed", data: { nodeId: `api-${matchedIntegration.id}`, error: errorMsg } });
        } else if (target) {
          const nodePrefix = target.kind === "tool" ? "tool" : "skill";
          emit({
            type: target.kind === "tool" ? "tool.failed" : "skill.failed",
            data: { nodeId: `${nodePrefix}-${target.id}`, error: errorMsg },
          } as ExecutionEvent);
        }
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: { error: errorMsg },
        });
        if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
        observeToolOutcome(tc.toolName, false);
      }
      continue;
    }

    // Check for synthesized tool first — these live in tool frontmatter, not mcpManager connections
    const sepIndex = tc.toolName.indexOf("__");
    const maybeToolId = sepIndex !== -1 ? tc.toolName.slice(0, sepIndex) : "";
    const maybeEndpointName = sepIndex !== -1 ? tc.toolName.slice(sepIndex + 2) : "";
    const synthesizedTool = maybeToolId
      ? loadTools().find((t) => t.id === maybeToolId && t.mcpServer?.transport === "synthesized")
      : undefined;

    if (synthesizedTool) {
      const toolId = synthesizedTool.id;
      const gate = await runSecurityGate(tc, "synthesized", {
        toolId,
        endpointName: maybeEndpointName,
        group: synthesizedTool.metadata.group,
      });
      if (!gate.allowed) {
        toolResults.push(gate.result);
        continue;
      }
      emit({
        type: "brain.decision",
        data: { toolId, capabilityKind: "tool", reason: `Calling synthesized ${maybeEndpointName}` },
      });
      emit({
        type: "tool.invoked",
        data: { nodeId: `tool-${toolId}`, toolId },
      });

      const synthActionHandle = beginAction("synthesized_call", tc.toolName, tc.args, actorCtx);
      try {
        const { callSynthesizedEndpoint } = await import("../synthesized-caller.ts");
        const callResult = await callSynthesizedEndpoint(synthesizedTool, maybeEndpointName, tc.args, {
          sessionId: options?.sessionId,
          originClientId: options?.originClientId,
          preferredUsageContext,
          allowedCredentialTypes: bagScope.allowedCredentialTypes ? Array.from(bagScope.allowedCredentialTypes) : undefined,
          onCredentialResolved: (info) => {
            emit({
              type: "credential.resolved",
              data: { ...info, surface: "synthesized" },
            });
          },
        });

        if (callResult.ok) {
          finishAction(synthActionHandle, { status: callResult.status, body: callResult.body, truncated: callResult.truncated });
          emit({
            type: "tool.completed",
            data: { nodeId: `tool-${toolId}`, output: callResult },
          });
          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: { status: callResult.status, body: callResult.body, truncated: callResult.truncated },
          });
          if (emotionEngine) toolOutcomeResults.push({ success: true, severity: toolSeverity(tc.toolName) });
          observeToolOutcome(tc.toolName, true);
        } else {
          const errorPayload = callResult.diagnosis
            ? { error: callResult.error, diagnosis: callResult.diagnosis }
            : { error: callResult.error };
          failAction(synthActionHandle, callResult.error);
          emit({
            type: "tool.failed",
            data: { nodeId: `tool-${toolId}`, error: callResult.error },
          });
          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: errorPayload,
          });
          if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
          observeToolOutcome(tc.toolName, false);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logError("tool_failure", err, { toolName: tc.toolName, toolId, sessionId: options?.sessionId });
        failAction(synthActionHandle, err);
        emit({
          type: "tool.failed",
          data: { nodeId: `tool-${toolId}`, error: errorMsg },
        });
        toolResults.push({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          result: { error: errorMsg },
        });
        if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
        observeToolOutcome(tc.toolName, false);
      }
      continue;
    }

    const parsed = mcpManager.findToolForQualifiedName(tc.toolName);
    if (!parsed) {
      emit({
        type: "tool.failed",
        data: {
          nodeId: tc.toolName,
          error: `Unknown tool: ${tc.toolName}`,
        },
      });
      toolResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: { error: `Unknown tool: ${tc.toolName}` },
      });
      continue;
    }

    const { toolId, toolName } = parsed;
    const mcpToolMeta = loadTools().find((t) => t.id === toolId);
    const mcpGate = await runSecurityGate(tc, "mcp", {
      toolId,
      endpointName: toolName,
      group: mcpToolMeta?.metadata.group,
    });
    if (!mcpGate.allowed) {
      toolResults.push(mcpGate.result);
      continue;
    }

    emit({
      type: "brain.decision",
      data: { toolId, capabilityKind: "tool", reason: `Calling ${toolName}` },
    });
    emit({
      type: "tool.invoked",
      data: { nodeId: `tool-${toolId}`, toolId },
    });

    const mcpActionHandle = beginAction("mcp_call", tc.toolName, tc.args, actorCtx);
    try {
      const mcpResult = await mcpManager.callTool(toolId, toolName, tc.args);
      const mcpMedia = extractMedia(mcpResult);
      const sanitizedMcpResult = sanitizeResultForLLM(mcpResult, mcpMedia);
      const publicMcpMedia = publicMedia(mcpMedia);

      finishAction(mcpActionHandle, sanitizedMcpResult);
      emit({
        type: "tool.completed",
        data: { nodeId: `tool-${toolId}`, output: sanitizedMcpResult, ...(publicMcpMedia.length > 0 ? { media: publicMcpMedia } : {}) },
      });

      toolResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: mcpResult,
        ...(mcpMedia.length > 0 ? { media: mcpMedia } : {}),
      });
      if (emotionEngine) toolOutcomeResults.push({ success: true, severity: toolSeverity(tc.toolName) });
      observeToolOutcome(tc.toolName, true);
    } catch (err) {
      let errorMsg = err instanceof Error ? err.message : String(err);
      // Nudge LLM toward native fallback on rate-limit errors
      if (/rate.?limit|429|too many req/i.test(errorMsg)) {
        errorMsg += " — Try using native__web_search as a fallback.";
      }
      logError("tool_failure", err, { toolName: tc.toolName, toolId, sessionId: options?.sessionId });
      failAction(mcpActionHandle, err);
      emit({
        type: "tool.failed",
        data: { nodeId: `tool-${toolId}`, error: errorMsg },
      });
      toolResults.push({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: { error: errorMsg },
      });
      if (emotionEngine) toolOutcomeResults.push({ success: false, severity: toolSeverity(tc.toolName) });
      observeToolOutcome(tc.toolName, false);
    }
  }

  return { toolResults, roundToolOutcomes, toolOutcomeResults };
}
