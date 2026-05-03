import { createContext, useContext, useId, useMemo, useState, type ChangeEvent } from "react";
import type {
  A2UITextComponent,
  A2UIColumnComponent,
  A2UIRowComponent,
  A2UIImageComponent,
  A2UITableComponent,
  A2UIButtonComponent,
  A2UIFormComponent,
  A2UIInputComponent,
  A2UIChartComponent,
  A2UISurface,
} from "@chvor/shared";
import { parseA2UIAction } from "@chvor/shared";
import { resolveValue, resolveArray } from "./resolve";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useA2UIAction } from "./action-context";
import type { A2UIActionState } from "../../stores/runtime-store";

type FormValues = Record<string, string>;
const A2UIFormContext = createContext<{
  values: FormValues;
  setValue: (key: string, value: string) => void;
} | null>(null);

// Cap individual form values before re-encoding so a single oversized field
// can't dominate the daemon prompt's <a2ui-payload> block (server still
// re-truncates the JSON to 2KB, but per-field clamping keeps every field at
// least minimally visible and bounds prompt-injection surface).
const FORM_VALUE_MAX_CHARS = 512;
function clampFormValues(values: FormValues): FormValues {
  const out: FormValues = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = typeof value === "string" ? value.slice(0, FORM_VALUE_MAX_CHARS) : "";
  }
  return out;
}

function mergeFormValuesIntoAction(raw: string, values: FormValues): string {
  const parsed = parseA2UIAction(raw);
  if (!parsed || parsed.kind !== "emit") return raw;
  const payload =
    parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
      ? (parsed.payload as Record<string, unknown>)
      : {};
  return `emit:${parsed.eventName}?${encodeURIComponent(JSON.stringify({ ...payload, form: clampFormValues(values) }))}`;
}

const ACTIVE_ACTION_STATUSES = new Set<A2UIActionState["status"]>(["queued", "running"]);
const ACTION_STATUS_LABEL: Record<A2UIActionState["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function A2UIActionStatusLine({ state }: { state: A2UIActionState | null }) {
  if (!state) return null;
  const isBad = state.status === "failed" || state.status === "cancelled";
  const isDone = state.status === "completed";
  return (
    <div
      className={cn(
        "mt-1.5 max-w-full text-[11px]",
        isBad ? "text-destructive" : isDone ? "text-emerald-500" : "text-muted-foreground"
      )}
    >
      <span className="font-medium">{ACTION_STATUS_LABEL[state.status]}</span>
      <span className="text-muted-foreground"> · {state.title}</span>
      {state.error && <span className="block truncate">{state.error}</span>}
    </div>
  );
}

/* ─── Shared child renderer ─── */

interface ChildProps {
  nodeId: string;
  surface: A2UISurface;
  renderNode: (
    nodeId: string,
    surface: A2UISurface,
    visited?: Set<string>,
    depth?: number
  ) => React.ReactNode;
}

function Child({ nodeId, surface, renderNode }: ChildProps) {
  return <>{renderNode(nodeId, surface)}</>;
}

/* ─── Text ─── */

const HINT_CLASSES: Record<string, string> = {
  h1: "text-xl font-semibold text-foreground tracking-tight",
  h2: "text-base font-medium text-foreground",
  h3: "text-sm font-medium text-foreground",
  body: "text-sm text-foreground leading-relaxed",
  caption: "text-xs text-muted-foreground",
  code: "font-mono text-[13px] bg-muted px-1.5 py-0.5 rounded text-foreground",
};

export function A2UIText({
  spec,
  bindings,
}: {
  spec: A2UITextComponent["Text"];
  bindings: Record<string, unknown>;
}) {
  const text = resolveValue(spec.text, bindings);
  const hint = spec.usageHint ?? "body";
  const cls = HINT_CLASSES[hint] ?? HINT_CLASSES.body;

  if (hint === "h1") return <h1 className={cls}>{text}</h1>;
  if (hint === "h2") return <h2 className={cls}>{text}</h2>;
  if (hint === "h3") return <h3 className={cls}>{text}</h3>;
  if (hint === "code") return <code className={cls}>{text}</code>;
  return <p className={cls}>{text}</p>;
}

/* ─── Column ─── */

const ALIGN_MAP: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
};

export function A2UIColumn({
  spec,
  surface,
  renderNode,
}: {
  spec: A2UIColumnComponent["Column"];
  surface: A2UISurface;
  renderNode: (
    nodeId: string,
    surface: A2UISurface,
    visited?: Set<string>,
    depth?: number
  ) => React.ReactNode;
}) {
  const align = ALIGN_MAP[spec.align ?? "start"] ?? "";
  const gap = spec.gap ?? 8;
  const children = spec.children?.explicitList ?? [];
  return (
    <div className={cn("flex flex-col", align)} style={{ gap }}>
      {children.map((childId) => (
        <Child key={childId} nodeId={childId} surface={surface} renderNode={renderNode} />
      ))}
    </div>
  );
}

/* ─── Row ─── */

export function A2UIRow({
  spec,
  surface,
  renderNode,
}: {
  spec: A2UIRowComponent["Row"];
  surface: A2UISurface;
  renderNode: (
    nodeId: string,
    surface: A2UISurface,
    visited?: Set<string>,
    depth?: number
  ) => React.ReactNode;
}) {
  const align = ALIGN_MAP[spec.align ?? "start"] ?? "";
  const gap = spec.gap ?? 8;
  const children = spec.children?.explicitList ?? [];
  return (
    <div className={cn("flex flex-row flex-wrap", align)} style={{ gap }}>
      {children.map((childId) => (
        <Child key={childId} nodeId={childId} surface={surface} renderNode={renderNode} />
      ))}
    </div>
  );
}

/* ─── Image ─── */

export function isSafeImageSrc(src: string): boolean {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  // Allow http(s) and data:image/*
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^data:image\//i.test(trimmed)) return true;
  // Block relative paths (could hit internal API routes), javascript:, data:text/html, etc.
  return false;
}

export function A2UIImage({
  spec,
  bindings,
}: {
  spec: A2UIImageComponent["Image"];
  bindings: Record<string, unknown>;
}) {
  const src = resolveValue(spec.src, bindings);

  if (!isSafeImageSrc(src)) {
    return (
      <div className="rounded-lg border border-border p-4 text-center">
        <p className="text-xs text-muted-foreground">Blocked image source</p>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={spec.alt || "Image"}
      width={spec.width}
      height={spec.height}
      className="rounded-lg border border-border max-w-full object-contain"
    />
  );
}

/* ─── Table ─── */

export function A2UITable({
  spec,
  bindings,
}: {
  spec: A2UITableComponent["Table"];
  bindings: Record<string, unknown>;
}) {
  const rows = resolveArray(spec.rows, bindings) as Record<string, unknown>[];

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6 text-center">
        <p className="text-xs text-muted-foreground">{spec.emptyText ?? "No data to display"}</p>
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-lg border border-border"
      role="region"
      aria-label="Scrollable table"
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted">
            {spec.columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowKey = spec.columns.map((c) => String(row[c.key] ?? "")).join("|") || String(i);
            return (
              <tr
                key={rowKey}
                className="border-b border-border last:border-0 hover:bg-muted transition-colors"
              >
                {spec.columns.map((col) => (
                  <td
                    key={col.key}
                    className="px-3 py-2 text-foreground tabular-nums max-w-xs truncate"
                  >
                    {row[col.key] != null ? String(row[col.key]) : ""}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Button ─── */

const VARIANT_MAP: Record<string, "default" | "secondary" | "ghost"> = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
};

export function A2UIButton({
  spec,
  bindings,
  sourceId,
}: {
  spec: A2UIButtonComponent["Button"];
  bindings: Record<string, unknown>;
  sourceId?: string;
}) {
  const label = resolveValue(spec.label, bindings);
  const variant = VARIANT_MAP[spec.variant ?? "primary"] ?? "default";
  const { fire, enabled, state } = useA2UIAction(sourceId);
  const [pending, setPending] = useState(false);
  // The button is enabled only when a host dispatcher is registered AND the
  // action string passes the allowlist. Anything else renders disabled with
  // a hint, so the user can see something was filtered out.
  const isNoop = !spec.action || spec.action === "noop";
  const actionActive = state ? ACTIVE_ACTION_STATUSES.has(state.status) : false;
  const disabled = !enabled || isNoop || pending || actionActive;

  return (
    <div className="inline-flex max-w-full flex-col items-start">
      <Button
        variant={variant}
        size="sm"
        disabled={disabled}
        aria-busy={pending || actionActive}
        title={
          !enabled
            ? "Actions disabled — no host dispatcher"
            : isNoop
              ? "No action bound"
              : pending || actionActive
                ? "Action is in progress"
                : undefined
        }
        onClick={async () => {
          if (isNoop || pending || actionActive) return;
          setPending(true);
          try {
            await fire(spec.action, sourceId);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Queuing…" : actionActive ? ACTION_STATUS_LABEL[state!.status] : label}
      </Button>
      <A2UIActionStatusLine state={state} />
    </div>
  );
}

/* ─── Form ─── */

export function A2UIForm({
  spec,
  surface,
  renderNode,
  sourceId,
}: {
  spec: A2UIFormComponent["Form"];
  surface: A2UISurface;
  renderNode: (
    nodeId: string,
    surface: A2UISurface,
    visited?: Set<string>,
    depth?: number
  ) => React.ReactNode;
  sourceId?: string;
}) {
  const children = spec.children?.explicitList ?? [];
  const { fire, enabled, state } = useA2UIAction(sourceId);
  const isNoop = !spec.submitAction || spec.submitAction === "noop";
  const [values, setValues] = useState<FormValues>({});
  const [pending, setPending] = useState(false);
  const actionActive = state ? ACTIVE_ACTION_STATUSES.has(state.status) : false;
  const disabled = !enabled || isNoop || pending || actionActive;
  const formContextValue = useMemo(
    () => ({
      values,
      setValue: (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value })),
    }),
    [values]
  );

  return (
    <A2UIFormContext.Provider value={formContextValue}>
      <form
        className="flex flex-col gap-3 rounded-lg border border-border p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (isNoop || pending || actionActive) return;
          setPending(true);
          try {
            await fire(mergeFormValuesIntoAction(spec.submitAction, values), sourceId);
          } finally {
            setPending(false);
          }
        }}
      >
        {children.map((childId) => (
          <Child key={childId} nodeId={childId} surface={surface} renderNode={renderNode} />
        ))}
        <Button
          type="submit"
          size="sm"
          className="self-start mt-1"
          disabled={disabled}
          aria-busy={pending || actionActive}
          title={
            !enabled
              ? "Form submission disabled — no host dispatcher"
              : isNoop
                ? "No submit action bound"
                : pending || actionActive
                  ? "Submission is in progress"
                  : undefined
          }
        >
          {pending
            ? "Queuing…"
            : actionActive
              ? ACTION_STATUS_LABEL[state!.status]
              : (spec.submitLabel ?? "Submit")}
        </Button>
        <A2UIActionStatusLine state={state} />
      </form>
    </A2UIFormContext.Provider>
  );
}

/* ─── Input ─── */
export function A2UIInput({ spec }: { spec: A2UIInputComponent["Input"] }) {
  const inputId = useId();
  const form = useContext(A2UIFormContext);
  const value = form?.values[spec.bindTo] ?? "";

  return (
    <div className="flex flex-col gap-1.5">
      {spec.placeholder && (
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          {spec.placeholder}
        </label>
      )}
      <input
        id={inputId}
        type={spec.inputType ?? "text"}
        placeholder={spec.placeholder ?? ""}
        {...(form
          ? {
              value,
              onChange: (e: ChangeEvent<HTMLInputElement>) =>
                form.setValue(spec.bindTo, e.target.value),
            }
          : {})}
        className="h-9 w-full rounded-md border border-border bg-input px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  );
}

/* ─── Chart ─── */

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function A2UIChart({
  spec,
  bindings,
}: {
  spec: A2UIChartComponent["Chart"];
  bindings: Record<string, unknown>;
}) {
  const rawData = resolveArray(spec.data, bindings) as Array<{
    label?: string;
    value?: number;
  }>;

  if (rawData.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6 text-center">
        <p className="text-xs text-muted-foreground">No chart data</p>
      </div>
    );
  }

  // Clamp negative values to 0 for chart rendering
  const values = rawData.map((d) => Math.max(0, d.value ?? 0));
  const maxVal = Math.max(...values, 1);
  const chartHeight = 140;
  const padTop = 10;
  const padBottom = 28;
  const padLeft = 36;
  const padRight = 12;

  // Y-axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxVal * f));

  const chartTitle = spec.title ?? "Chart";
  const dataDesc = rawData.map((d) => `${d.label ?? "?"}: ${d.value ?? 0}`).join(", ");

  if (spec.chartType === "line") {
    const step = Math.max(30, Math.min(50, 600 / rawData.length));
    const contentWidth = rawData.length * step;
    const width = padLeft + contentWidth + padRight;
    const height = padTop + chartHeight + padBottom;

    const points = rawData
      .map((d, i) => {
        const x = padLeft + i * step + step / 2;
        const y = padTop + chartHeight - (values[i] / maxVal) * chartHeight;
        return `${x},${y}`;
      })
      .join(" ");

    return (
      <div className="space-y-2">
        {spec.title && <p className="text-sm font-medium text-foreground">{spec.title}</p>}
        <div className="overflow-x-auto rounded-lg border border-border p-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full"
            style={{ minWidth: width }}
            role="img"
            aria-label={`${chartTitle}: ${dataDesc}`}
          >
            <title>{chartTitle}</title>
            {/* Grid lines */}
            {ticks.map((tick, i) => {
              const y = padTop + chartHeight - (tick / maxVal) * chartHeight;
              return (
                <g key={i}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={width - padRight}
                    y2={y}
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  <text
                    x={padLeft - 6}
                    y={y + 3}
                    textAnchor="end"
                    fill="var(--muted-foreground)"
                    fontSize="9"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {tick}
                  </text>
                </g>
              );
            })}
            {/* Line */}
            <polyline
              points={points}
              fill="none"
              stroke={CHART_COLORS[0]}
              strokeWidth="2"
              strokeLinejoin="round"
            />
            {/* Data points + labels */}
            {rawData.map((d, i) => {
              const x = padLeft + i * step + step / 2;
              const y = padTop + chartHeight - (values[i] / maxVal) * chartHeight;
              return (
                <g key={i}>
                  <circle cx={x} cy={y} r="3" fill={CHART_COLORS[0]} />
                  <text
                    x={x}
                    y={padTop + chartHeight + 16}
                    textAnchor="middle"
                    fill="var(--muted-foreground)"
                    fontSize="9"
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {d.label ?? i}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    );
  }

  // Bar chart (default, fallback for unsupported chart types)
  const barWidth = Math.min(32, Math.floor(240 / rawData.length));
  const barGap = 6;
  const contentWidth = rawData.length * (barWidth + barGap);
  const width = padLeft + contentWidth + padRight;
  const height = padTop + chartHeight + padBottom;

  return (
    <div className="space-y-2">
      {spec.title && <p className="text-sm font-medium text-foreground">{spec.title}</p>}
      <div className="rounded-lg border border-border p-3">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-label={`${chartTitle}: ${dataDesc}`}
        >
          <title>{chartTitle}</title>
          {/* Grid lines */}
          {ticks.map((tick, i) => {
            const y = padTop + chartHeight - (tick / maxVal) * chartHeight;
            return (
              <g key={i}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="var(--border)"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 6}
                  y={y + 3}
                  textAnchor="end"
                  fill="var(--muted-foreground)"
                  fontSize="9"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {tick}
                </text>
              </g>
            );
          })}
          {/* Baseline */}
          <line
            x1={padLeft}
            y1={padTop + chartHeight}
            x2={width - padRight}
            y2={padTop + chartHeight}
            stroke="var(--border)"
            strokeWidth="1"
          />
          {/* Bars */}
          {rawData.map((d, i) => {
            const h = (values[i] / maxVal) * chartHeight;
            const x = padLeft + i * (barWidth + barGap) + barGap / 2;
            const y = padTop + chartHeight - h;
            const color = CHART_COLORS[i % CHART_COLORS.length];
            return (
              <g key={i}>
                <rect x={x} y={y} width={barWidth} height={h} rx={2} fill={color} />
                <text
                  x={x + barWidth / 2}
                  y={padTop + chartHeight + 16}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="9"
                  fontFamily="var(--font-mono, monospace)"
                >
                  {d.label ?? i}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
