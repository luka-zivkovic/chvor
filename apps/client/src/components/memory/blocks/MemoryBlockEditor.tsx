import { useEffect, useState } from "react";
import type { MemoryBlockDocumentV1, MemoryBlockRecord } from "@chvor/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  canonicalNow,
  contentCount,
  errorMessage,
  applyTextareaEdit,
  prettyJson,
  textareaValue,
  validateDocument,
} from "./memory-block-utils";
import type { MutationResult } from "./types";

type DirtyField =
  | "label"
  | "description"
  | "content"
  | "characterBudget"
  | "declaredOrder"
  | "readOnly"
  | "provenance"
  | "proceduralPriority";

export function MemoryBlockEditor({
  current,
  disabled,
  onSubmit,
  onDirtyChange,
}: {
  current: MemoryBlockRecord;
  disabled: boolean;
  onSubmit: (document: MemoryBlockDocumentV1) => Promise<MutationResult>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const source = current.document;
  const [label, setLabel] = useState(source.label);
  const [description, setDescription] = useState(source.description ?? "");
  const [descriptionIsNull, setDescriptionIsNull] = useState(source.description === null);
  const [content, setContent] = useState(source.content);
  const [characterBudget, setCharacterBudget] = useState(String(source.characterBudget.limit));
  const [declaredOrder, setDeclaredOrder] = useState(String(source.declaredOrder));
  const [readOnly, setReadOnly] = useState(source.readOnly);
  const [provenance, setProvenance] = useState(prettyJson(source.provenance));
  const [proceduralPriority, setProceduralPriority] = useState(
    source.layer === "procedural" ? source.proceduralPriority : "optional"
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirtyFields, setDirtyFields] = useState<Set<DirtyField>>(() => new Set());
  const submittedContent = dirtyFields.has("content") ? content : source.content;
  const dirty =
    (dirtyFields.has("label") && label !== source.label) ||
    (dirtyFields.has("description") &&
      (descriptionIsNull ? null : description) !== source.description) ||
    (dirtyFields.has("content") && submittedContent !== source.content) ||
    (dirtyFields.has("characterBudget") &&
      characterBudget !== String(source.characterBudget.limit)) ||
    (dirtyFields.has("declaredOrder") && declaredOrder !== String(source.declaredOrder)) ||
    (dirtyFields.has("readOnly") && readOnly !== source.readOnly) ||
    (dirtyFields.has("provenance") && provenance !== prettyJson(source.provenance)) ||
    (dirtyFields.has("proceduralPriority") &&
      source.layer === "procedural" &&
      proceduralPriority !== source.proceduralPriority);

  const markDirty = (field: DirtyField) => {
    setDirtyFields((current) => new Set(current).add(field));
  };

  useEffect(() => {
    if (!dirtyFields.has("label")) setLabel(source.label);
    if (!dirtyFields.has("description")) {
      setDescription(source.description ?? "");
      setDescriptionIsNull(source.description === null);
    }
    if (!dirtyFields.has("content")) setContent(source.content);
    if (!dirtyFields.has("characterBudget")) {
      setCharacterBudget(String(source.characterBudget.limit));
    }
    if (!dirtyFields.has("declaredOrder")) setDeclaredOrder(String(source.declaredOrder));
    if (!dirtyFields.has("readOnly")) setReadOnly(source.readOnly);
    if (!dirtyFields.has("provenance")) setProvenance(prettyJson(source.provenance));
    if (!dirtyFields.has("proceduralPriority") && source.layer === "procedural") {
      setProceduralPriority(source.proceduralPriority);
    }
  }, [dirtyFields, source]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const buildDocument = (verify: boolean): MemoryBlockDocumentV1 => {
    let parsedProvenance: unknown;
    try {
      parsedProvenance = JSON.parse(provenance) as unknown;
    } catch {
      throw new Error("provenance: must be valid structured JSON");
    }

    const contentChanged = submittedContent !== source.content;
    const candidate = {
      ...source,
      label: dirtyFields.has("label") ? label : source.label,
      description: dirtyFields.has("description")
        ? descriptionIsNull
          ? null
          : description
        : source.description,
      content: submittedContent,
      characterBudget: {
        unit: "characters" as const,
        limit: dirtyFields.has("characterBudget")
          ? Number(characterBudget)
          : source.characterBudget.limit,
      },
      declaredOrder: dirtyFields.has("declaredOrder")
        ? Number(declaredOrder)
        : source.declaredOrder,
      readOnly: dirtyFields.has("readOnly") ? readOnly : source.readOnly,
      provenance: dirtyFields.has("provenance") ? parsedProvenance : source.provenance,
      verifiedAt: verify ? canonicalNow() : contentChanged ? null : source.verifiedAt,
      ...(source.layer === "procedural"
        ? {
            proceduralPriority: dirtyFields.has("proceduralPriority")
              ? proceduralPriority
              : source.proceduralPriority,
          }
        : {}),
    };
    return validateDocument(candidate);
  };

  const resetDraft = () => {
    setDirtyFields(new Set());
    setError(null);
    setNotice("Draft reset to the canonical snapshot.");
  };

  const save = async (verify: boolean) => {
    setError(null);
    setNotice(null);
    let document: MemoryBlockDocumentV1;
    try {
      document = buildDocument(verify);
    } catch (validationError) {
      setError(errorMessage(validationError, "Invalid memory block snapshot."));
      return;
    }

    setSaving(true);
    try {
      const result = await onSubmit(document);
      if (result.kind === "updated") {
        setNotice(`Saved revision ${result.record.revision}${verify ? " and verified" : ""}.`);
      }
    } catch (saveError) {
      setError(errorMessage(saveError, "Could not save the correction."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="memory-editor-heading"
      className="space-y-3 rounded-lg border border-border/60 p-3"
    >
      <div>
        <h3 id="memory-editor-heading" className="text-xs font-semibold text-foreground">
          Correct current snapshot
        </h3>
        <p className="text-[10px] text-muted-foreground">
          Layer and manager are immutable. Content is saved exactly as entered; empty content is
          valid.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-green-500">
          {notice}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[10px] text-muted-foreground">
          Layer (immutable)
          <Input value={source.layer} readOnly disabled className="mt-1 h-8 text-xs" />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Managed by (immutable)
          <Input value={source.managedBy} readOnly disabled className="mt-1 h-8 text-xs" />
        </label>
      </div>

      <label className="block text-[10px] text-muted-foreground">
        Label
        <Input
          aria-label="Block label"
          value={label}
          disabled={disabled || saving}
          onChange={(event) => {
            setLabel(event.target.value);
            markDirty("label");
          }}
          className="mt-1 h-8 text-xs"
        />
      </label>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            checked={descriptionIsNull}
            disabled={disabled || saving}
            onChange={(event) => {
              setDescriptionIsNull(event.target.checked);
              markDirty("description");
            }}
          />
          No description (store null)
        </label>
        <Textarea
          aria-label="Block description"
          value={description}
          disabled={disabled || saving || descriptionIsNull}
          onChange={(event) => {
            setDescription(event.target.value);
            markDirty("description");
          }}
          className="min-h-16 text-xs"
        />
      </div>

      <label className="block text-[10px] text-muted-foreground">
        Content
        <Textarea
          aria-label="Block content"
          value={textareaValue(content)}
          disabled={disabled || saving}
          onChange={(event) => {
            setContent(
              applyTextareaEdit(
                content,
                event.target.value,
                event.target.selectionStart ?? event.target.value.length
              )
            );
            markDirty("content");
          }}
          className="mt-1 min-h-40 whitespace-pre-wrap font-mono text-xs"
        />
        <span>
          {contentCount(dirtyFields.has("content") ? content : source.content)} Unicode characters ·
          budget {characterBudget || "—"}
        </span>
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[10px] text-muted-foreground">
          Character budget
          <Input
            aria-label="Character budget"
            type="number"
            min={1}
            value={characterBudget}
            disabled={disabled || saving}
            onChange={(event) => {
              setCharacterBudget(event.target.value);
              markDirty("characterBudget");
            }}
            className="mt-1 h-8 text-xs"
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          Declared order
          <Input
            aria-label="Declared order"
            type="number"
            min={0}
            value={declaredOrder}
            disabled={disabled || saving}
            onChange={(event) => {
              setDeclaredOrder(event.target.value);
              markDirty("declaredOrder");
            }}
            className="mt-1 h-8 text-xs"
          />
        </label>
      </div>

      {source.layer === "procedural" && (
        <label className="block text-[10px] text-muted-foreground">
          Procedural priority
          <select
            aria-label="Procedural priority"
            value={proceduralPriority}
            disabled={disabled || saving}
            onChange={(event) => {
              setProceduralPriority(event.target.value as "required" | "optional");
              markDirty("proceduralPriority");
            }}
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="required">required</option>
            <option value="optional">optional</option>
          </select>
        </label>
      )}

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={readOnly}
          disabled={disabled || saving}
          onChange={(event) => {
            setReadOnly(event.target.checked);
            markDirty("readOnly");
          }}
        />
        Prevent agent changes
      </label>

      <label className="block text-[10px] text-muted-foreground">
        Provenance (structured JSON object)
        <Textarea
          aria-label="Provenance JSON"
          value={provenance}
          disabled={disabled || saving}
          onChange={(event) => {
            setProvenance(event.target.value);
            markDirty("provenance");
          }}
          spellCheck={false}
          className="mt-1 min-h-28 font-mono text-[10px]"
        />
      </label>

      <p className="text-[10px] text-muted-foreground">
        Confidence is preserved at {source.confidence}. Saving changed content clears stale
        verification; Save and verify records the current millisecond UTC instant.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          onClick={resetDraft}
        >
          Reset draft
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || saving}
          onClick={() => void save(false)}
        >
          {saving ? "Saving…" : "Save correction"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || saving}
          onClick={() => void save(true)}
        >
          {saving ? "Saving…" : "Save and verify"}
        </Button>
      </div>
    </section>
  );
}
