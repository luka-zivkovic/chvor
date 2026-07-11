import { useState } from "react";
import type { TrajectoryDetail, TrajectoryStepDetail } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SaveEvaluationCaseDialog } from "./SaveEvaluationCaseDialog";

const STATUS_STYLE: Record<string, string> = {
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  aborted: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  waiting: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  running: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  pending: "border-border bg-muted/30 text-muted-foreground",
  skipped: "border-border bg-muted/30 text-muted-foreground",
  "round-limited": "border-orange-500/30 bg-orange-500/10 text-orange-300",
};

function duration(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function timestamp(value?: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function tokenCount(usage: { inputTokens: number; outputTokens: number; totalTokens?: number }) {
  return usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[Unserializable value]";
  }
}

export function PayloadBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  const rendered = displayValue(value);
  const redacted = rendered.includes("[REDACTED]");
  return (
    <section className="rounded-lg border border-border/40 bg-background/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </h4>
      </div>
      <pre
        className={cn(
          "max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed",
          redacted ? "text-rose-200" : "text-foreground/80"
        )}
      >
        {rendered}
      </pre>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase",
        STATUS_STYLE[status] ?? STATUS_STYLE.pending
      )}
    >
      {status}
    </span>
  );
}

function StepCard({ step }: { step: TrajectoryStepDetail }) {
  const approval = step.approval as Record<string, unknown> | undefined;
  const model = step.modelUsage;
  return (
    <article className="relative rounded-xl border border-border/50 bg-card/30 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[9px] text-muted-foreground">#{step.sequence}</span>
            <span className="font-mono text-[10px] text-primary/80">{step.kind}</span>
            {step.error?.retryable && <span className="text-[9px] text-amber-300">retryable</span>}
            {model?.wasFallback && <span className="text-[9px] text-orange-300">fallback</span>}
          </div>
          {step.name && <h3 className="mt-1 truncate text-xs font-medium">{step.name}</h3>}
        </div>
        <StatusBadge status={step.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-muted-foreground sm:grid-cols-4">
        <span>start · {timestamp(step.startedAt)}</span>
        <span>duration · {duration(step.durationMs)}</span>
        {model && (
          <span>
            model · {model.providerId}/{model.modelId}
          </span>
        )}
        {model && <span>tokens · {tokenCount(model)}</span>}
      </div>

      {step.toolCall && (
        <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2.5 text-[10px]">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-cyan-200">
            <span>tool · {step.toolCall.toolName}</span>
            <span>kind · {step.toolCall.toolKind}</span>
            <span>call · {step.toolCall.toolCallId}</span>
          </div>
          {step.toolCall.credentialRefs.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              credential refs ·{" "}
              {step.toolCall.credentialRefs.map((ref) => ref.credentialType).join(", ")}
            </p>
          )}
        </div>
      )}

      {approval && (
        <div className="mt-3 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5 text-[10px] text-violet-200">
          approval · {String(approval.kind ?? "action")} · {String(approval.risk ?? "unknown")} risk
          · {String(approval.status ?? "unknown")}
          {approval.decision ? ` · ${String(approval.decision)}` : ""}
        </div>
      )}

      {step.error && (
        <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-2.5 text-[10px] text-rose-200">
          <strong>{step.error.code}</strong> · {step.error.message}
        </div>
      )}

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <PayloadBlock label="input" value={step.input} />
        <PayloadBlock label="output" value={step.output} />
        <PayloadBlock label="tool args" value={step.toolCall?.args} />
        <PayloadBlock label="attributes" value={step.attributes} />
      </div>
      {step.artifacts.length > 0 && (
        <div className="mt-3">
          <PayloadBlock label="artifacts" value={step.artifacts} />
        </div>
      )}
    </article>
  );
}

export function TrajectoryInspector({ trajectory }: { trajectory: TrajectoryDetail }) {
  const [showEvaluationDialog, setShowEvaluationDialog] = useState(false);
  const steps = [...trajectory.steps].sort((left, right) => left.sequence - right.sequence);
  const active = ["pending", "running", "waiting"].includes(trajectory.status);
  const trajectoryAttributes =
    typeof trajectory.attributes === "object" &&
    trajectory.attributes !== null &&
    !Array.isArray(trajectory.attributes)
      ? (trajectory.attributes as Record<string, unknown>)
      : {};
  const attempt = trajectoryAttributes.attempt;
  const maxAttempts = trajectoryAttributes.maxAttempts;
  const attemptLabel =
    typeof attempt === "number" && Number.isInteger(attempt) && attempt > 0
      ? `attempt ${attempt}${typeof maxAttempts === "number" ? ` of ${maxAttempts}` : ""}`
      : null;

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-border/50 bg-card/30 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {trajectory.title ?? trajectory.summary ?? trajectory.id}
            </h2>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">{trajectory.id}</p>
          </div>
          <StatusBadge status={trajectory.status} />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3 h-7 text-[10px]"
          onClick={() => setShowEvaluationDialog(true)}
        >
          Save as evaluation
        </Button>
        {attemptLabel && (
          <p className="mt-2 font-mono text-[9px] uppercase text-amber-300">{attemptLabel}</p>
        )}
        {active && (
          <p className="mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 p-2 text-[10px] text-sky-200">
            This execution is partial and may receive more steps.
          </p>
        )}
        {trajectory.error && (
          <p className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 p-2 text-[10px] text-rose-200">
            {trajectory.error.code} · {trajectory.error.message}
          </p>
        )}
        <dl className="mt-3 grid grid-cols-2 gap-3 text-[10px] sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">origin</dt>
            <dd>{trajectory.origin.kind}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">actor</dt>
            <dd>
              {trajectory.actor.type}
              {trajectory.actor.id ? ` · ${trajectory.actor.id}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">started</dt>
            <dd>{timestamp(trajectory.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">duration</dt>
            <dd>{duration(trajectory.durationMs)}</dd>
          </div>
        </dl>
        {trajectory.modelUsage.length > 0 && (
          <div className="mt-3 border-t border-border/40 pt-3 text-[10px] text-muted-foreground">
            models ·{" "}
            {trajectory.modelUsage
              .map(
                (usage) =>
                  `${usage.providerId}/${usage.modelId} (${tokenCount(usage)} tokens${usage.wasFallback ? ", fallback" : ""})`
              )
              .join(" · ")}
          </div>
        )}
      </header>

      <div className="grid gap-2 lg:grid-cols-2">
        <PayloadBlock label="trajectory input" value={trajectory.input} />
        <PayloadBlock label="trajectory output" value={trajectory.output} />
        <PayloadBlock
          label="trajectory artifacts"
          value={trajectory.artifacts.length > 0 ? trajectory.artifacts : undefined}
        />
        <PayloadBlock label="trajectory attributes" value={trajectory.attributes} />
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Timeline
          </h2>
          <span className="text-[10px] text-muted-foreground">{steps.length} steps</span>
        </div>
        {steps.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
            No steps have been recorded yet.
          </p>
        ) : (
          <div className="space-y-2">
            {steps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        )}
      </section>
      {showEvaluationDialog && (
        <SaveEvaluationCaseDialog
          trajectory={trajectory}
          onClose={() => setShowEvaluationDialog(false)}
        />
      )}
    </div>
  );
}
