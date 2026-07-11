import { useEffect, useState } from "react";
import {
  redactTrajectoryText,
  sanitizeTrajectoryValue,
  type EvaluationCaseDocumentV1,
  type EvaluationCaseRecord,
  type EvaluationCaseSafetyAssertion,
  type EvaluationCaseStatus,
} from "@chvor/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { api, type TrajectoryDetail } from "../../lib/api";

const TERMINAL_STATUSES: EvaluationCaseStatus[] = [
  "aborted",
  "completed",
  "failed",
  "round-limited",
];

const SAFETY_ASSERTIONS: Array<{
  value: EvaluationCaseSafetyAssertion;
  label: string;
}> = [
  { value: "no-secrets-in-output", label: "No secrets in output" },
  { value: "forbid-unapproved-write-tools", label: "Forbid unapproved write tools" },
  {
    value: "require-approval-for-required-tools",
    label: "Require approval for required tools",
  },
];

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function prettySanitizedJson(value: unknown): string {
  return prettyJson(sanitizeTrajectoryValue(value));
}

function initialName(trajectory: TrajectoryDetail): string {
  return redactTrajectoryText(
    trajectory.title ?? trajectory.summary ?? `${trajectory.origin.kind} evaluation`
  );
}

function initialStatus(trajectory: TrajectoryDetail): EvaluationCaseStatus | "" {
  return TERMINAL_STATUSES.includes(trajectory.status as EvaluationCaseStatus)
    ? (trajectory.status as EvaluationCaseStatus)
    : "";
}

export function requiredToolsFromTrajectory(trajectory: TrajectoryDetail): string[] {
  return [
    ...new Set(
      trajectory.steps
        .map((step) => redactTrajectoryText(step.toolCall?.toolName?.trim() ?? ""))
        .filter(Boolean)
    ),
  ].sort();
}

function normalizedTextList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => redactTrajectoryText(entry.trim()))
        .filter(Boolean)
    ),
  ].sort();
}

function normalizedLineList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((entry) => redactTrajectoryText(entry.trim()))
        .filter(Boolean)
    ),
  ].sort();
}

function parsePayload(label: string, source: string) {
  if (!source.trim()) throw new Error(`${label} must contain JSON.`);
  try {
    return sanitizeTrajectoryValue(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be valid JSON.`);
    throw error;
  }
}

function safeFilename(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${stem || "evaluation-case"}.evaluation.json`;
}

interface Props {
  trajectory: TrajectoryDetail;
  onClose: () => void;
}

export function SaveEvaluationCaseDialog({ trajectory, onClose }: Props) {
  const [name, setName] = useState(initialName(trajectory));
  const inputWasTruncated = trajectory.payloadTruncation?.input === true;
  const outputWasTruncated = trajectory.payloadTruncation?.output === true;
  const [input, setInput] = useState(
    inputWasTruncated ? "" : prettySanitizedJson(trajectory.input ?? null)
  );
  const [status, setStatus] = useState<EvaluationCaseStatus | "">(initialStatus(trajectory));
  const [output, setOutput] = useState(
    trajectory.output === undefined || outputWasTruncated
      ? ""
      : prettySanitizedJson(trajectory.output)
  );
  const [outputContains, setOutputContains] = useState("");
  const [requiredTools, setRequiredTools] = useState(
    requiredToolsFromTrajectory(trajectory).join(", ")
  );
  const [forbiddenTools, setForbiddenTools] = useState("");
  const [safetyAssertions, setSafetyAssertions] = useState<EvaluationCaseSafetyAssertion[]>([
    "no-secrets-in-output",
  ]);
  const [savedRecord, setSavedRecord] = useState<EvaluationCaseRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(inputWasTruncated || outputWasTruncated);
  const [sourceOutputOmitted, setSourceOutputOmitted] = useState(false);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    if (!inputWasTruncated && !outputWasTruncated) return;
    let active = true;
    setSourceLoading(true);
    setError(null);
    void api.evaluationCases
      .sourceFromTrajectory(trajectory.id)
      .then((source) => {
        if (!active) return;
        if (inputWasTruncated) setInput(prettySanitizedJson(source.input));
        if (outputWasTruncated && source.output !== undefined) {
          setOutput(prettySanitizedJson(source.output));
        }
        setSourceOutputOmitted(source.outputOmitted);
      })
      .catch((sourceError: unknown) => {
        if (!active) return;
        setError(
          sourceError instanceof Error
            ? `Could not load complete trajectory payload: ${sourceError.message}`
            : "Could not load complete trajectory payload."
        );
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [inputWasTruncated, outputWasTruncated, trajectory.id]);

  const buildDocument = (): EvaluationCaseDocumentV1 => {
    const sanitizedName = redactTrajectoryText(name.trim());
    if (!sanitizedName) throw new Error("Name is required.");
    const expectedOutputContains = normalizedLineList(outputContains);
    const hasOutput = output.trim().length > 0;
    if (!status && !hasOutput && expectedOutputContains.length === 0) {
      throw new Error("Choose an expected status, output, or output substring.");
    }
    const normalizedRequiredTools = normalizedTextList(requiredTools);
    const normalizedForbiddenTools = normalizedTextList(forbiddenTools);
    const forbidden = new Set(normalizedForbiddenTools);
    const overlappingTools = normalizedRequiredTools.filter((tool) => forbidden.has(tool));
    if (overlappingTools.length > 0) {
      throw new Error(
        `Tools cannot be both required and forbidden: ${overlappingTools.join(", ")}.`
      );
    }

    return {
      schemaVersion: 1,
      name: sanitizedName,
      input: parsePayload("Input", input),
      expected: {
        ...(status ? { status } : {}),
        ...(hasOutput ? { output: parsePayload("Expected output", output) } : {}),
        outputContains: expectedOutputContains,
      },
      requiredTools: normalizedRequiredTools,
      forbiddenTools: normalizedForbiddenTools,
      safetyAssertions: [...new Set(safetyAssertions)].sort(),
    };
  };

  const reflectSanitizedDocument = (document: EvaluationCaseDocumentV1) => {
    setName(document.name);
    setInput(prettyJson(document.input));
    setOutput(document.expected.output === undefined ? "" : prettyJson(document.expected.output));
    setOutputContains(document.expected.outputContains.join("\n"));
    setRequiredTools(document.requiredTools.join(", "));
    setForbiddenTools(document.forbiddenTools.join(", "));
  };

  const handleSave = async () => {
    setError(null);
    setNotice(null);
    let document: EvaluationCaseDocumentV1;
    try {
      document = buildDocument();
    } catch (validationError) {
      setError(
        validationError instanceof Error ? validationError.message : "Invalid evaluation case."
      );
      return;
    }

    setSaving(true);
    try {
      const record = savedRecord
        ? await api.evaluationCases.update(savedRecord.id, {
            expectedRevision: savedRecord.revision,
            document,
          })
        : await api.evaluationCases.create({ document });
      setSavedRecord(record);
      reflectSanitizedDocument(record.document);
      const serialized = JSON.stringify(record.document);
      const redacted = serialized.includes("[REDACTED]");
      const removedTransientIds = serialized.includes("[TRANSIENT_ID]");
      const removedTransientTimestamps = serialized.includes("[TRANSIENT_TIMESTAMP]");
      setNotice(
        `Saved revision ${record.revision}.${redacted ? " Sensitive values are shown as [REDACTED]." : ""}${removedTransientIds ? " Transient identifiers are shown as [TRANSIENT_ID]." : ""}${removedTransientTimestamps ? " Transient timestamps are shown as [TRANSIENT_TIMESTAMP]." : ""}`
      );
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save evaluation case.");
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    if (!savedRecord) return;
    setExporting(true);
    setError(null);
    try {
      const content = await api.evaluationCases.export(savedRecord.id);
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = safeFilename(savedRecord.document.name);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : "Could not export evaluation case."
      );
    } finally {
      setExporting(false);
    }
  };

  const toggleSafetyAssertion = (assertion: EvaluationCaseSafetyAssertion) => {
    setSafetyAssertions((current) =>
      current.includes(assertion)
        ? current.filter((value) => value !== assertion)
        : [...current, assertion]
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="evaluation-case-title"
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="evaluation-case-title" className="text-sm font-semibold">
              Save as evaluation
            </h2>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Portable data excludes trajectory IDs, session IDs, tool-call IDs, approvals,
              artifacts, and timestamps.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close evaluation dialog" className="text-lg">
            &times;
          </button>
        </div>

        <div className="space-y-4">
          <label className="block text-[10px] text-muted-foreground">
            Name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-[10px] text-muted-foreground">
              Input JSON
              <Textarea
                aria-label="Input JSON"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="mt-1 min-h-36 font-mono text-[11px]"
              />
            </label>
            <label className="block text-[10px] text-muted-foreground">
              Expected output JSON (optional)
              <Textarea
                aria-label="Expected output JSON"
                value={output}
                onChange={(event) => setOutput(event.target.value)}
                className="mt-1 min-h-36 font-mono text-[11px]"
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-[10px] text-muted-foreground">
              Expected terminal status (optional)
              <select
                aria-label="Expected terminal status"
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
              >
                <option value="">No status assertion</option>
                {TERMINAL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] text-muted-foreground">
              Output contains (one substring per line)
              <Textarea
                aria-label="Output contains"
                value={outputContains}
                onChange={(event) => setOutputContains(event.target.value)}
                className="mt-1 min-h-20 text-xs"
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-[10px] text-muted-foreground">
              Required tools (comma-separated)
              <Input
                aria-label="Required tools"
                value={requiredTools}
                onChange={(event) => setRequiredTools(event.target.value)}
                className="mt-1"
              />
            </label>
            <label className="block text-[10px] text-muted-foreground">
              Forbidden tools (comma-separated)
              <Input
                aria-label="Forbidden tools"
                value={forbiddenTools}
                onChange={(event) => setForbiddenTools(event.target.value)}
                className="mt-1"
              />
            </label>
          </div>

          <fieldset>
            <legend className="text-[10px] text-muted-foreground">Safety assertions</legend>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {SAFETY_ASSERTIONS.map(({ value, label }) => (
                <label key={value} className="flex items-start gap-2 text-[10px]">
                  <input
                    type="checkbox"
                    checked={safetyAssertions.includes(value)}
                    onChange={() => toggleSafetyAssertion(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[10px] text-amber-100">
            Input, output, names, tools, and substrings use trajectory redaction. Redacted values
            remain visibly marked as [REDACTED].
          </p>
          {sourceLoading && (
            <p className="rounded-lg border border-orange-500/25 bg-orange-500/5 p-2 text-[10px] text-orange-100">
              Loading the complete trajectory payload through the protected execution API…
            </p>
          )}
          {sourceOutputOmitted && (
            <p className="rounded-lg border border-orange-500/25 bg-orange-500/5 p-2 text-[10px] text-orange-100">
              The complete output would exceed the evaluation-case limit. Use status or substring
              assertions instead.
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-2 text-[10px] text-rose-200"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2 text-[10px] text-emerald-200"
            >
              {notice}
            </p>
          )}
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!savedRecord || exporting}
            onClick={() => void handleExport()}
          >
            {exporting ? "Exporting…" : "Export JSON"}
          </Button>
          <Button size="sm" disabled={saving || sourceLoading} onClick={() => void handleSave()}>
            {sourceLoading
              ? "Loading payload…"
              : saving
                ? "Saving…"
                : savedRecord
                  ? "Update evaluation"
                  : "Create evaluation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
