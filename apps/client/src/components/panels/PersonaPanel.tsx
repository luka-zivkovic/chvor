import { useEffect, useState } from "react";
import { usePersonaStore } from "../../stores/persona-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { CommunicationStyle, ExampleResponse } from "@chvor/shared";
import { PERSONA_LIMITS } from "@chvor/shared";
import { PERSONALITY_PRESETS, TAG_CONFIG } from "@/lib/personality-presets";

const CORE_IDENTITY = `You are Chvor, a personal AI assistant. You operate transparently — your reasoning, tool usage, and decisions are visible on the user's Brain Canvas in real-time. Never attempt to hide your actions or reasoning from the user.`;

function buildPreview(
  profile: string,
  directives: string,
  tone: string,
  communicationStyle: string,
  boundaries: string,
  exampleResponses: ExampleResponse[]
): string {
  const sections: string[] = [CORE_IDENTITY];

  const hasStructured =
    tone.trim() ||
    communicationStyle ||
    boundaries.trim() ||
    exampleResponses.length > 0;

  if (hasStructured) {
    const parts: string[] = [];
    if (profile.trim()) parts.push(profile.trim());
    if (tone.trim()) parts.push(`**Tone:** ${tone.trim()}`);
    if (communicationStyle)
      parts.push(`**Communication style:** ${communicationStyle}`);
    if (boundaries.trim()) parts.push(`**Boundaries:** ${boundaries.trim()}`);
    if (exampleResponses.length > 0) {
      const exLines = exampleResponses
        .filter((ex) => ex.user.trim() || ex.assistant.trim())
        .map(
          (ex, i) =>
            `**Example ${i + 1}:**\nUser: ${ex.user}\nAssistant: ${ex.assistant}`
        )
        .join("\n\n");
      if (exLines) parts.push(exLines);
    }
    if (parts.length > 0)
      sections.push(`## Personality & Style\n\n${parts.join("\n\n")}`);
  } else if (profile.trim()) {
    sections.push(`## Profile\n\n${profile.trim()}`);
  }

  if (directives.trim())
    sections.push(`## Directives\n\n${directives.trim()}`);
  sections.push("## What I Know About You\n\n(memory facts injected here)");
  sections.push(
    "## Tool Usage\n\nYou can use the tools provided to help answer user questions. Use tools when they would provide better, more accurate, or more up-to-date information. When you don't need tools, respond directly and concisely."
  );
  sections.push("## Available Skill Instructions\n\n(skill details injected here)");
  return sections.join("\n\n");
}

export function PersonaPanel() {
  const { persona, loading, error, fetchPersona, updatePersona } =
    usePersonaStore();

  const [profile, setProfile] = useState("");
  const [directives, setDirectives] = useState("");
  const [tone, setTone] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [communicationStyle, setCommunicationStyle] = useState<
    CommunicationStyle | ""
  >("");
  const [exampleResponses, setExampleResponses] = useState<ExampleResponse[]>(
    []
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [pendingPresetId, setPendingPresetId] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    fetchPersona();
  }, [fetchPersona]);

  useEffect(() => {
    if (persona) {
      setProfile(persona.profile);
      setDirectives(persona.directives);
      setTone(persona.tone ?? "");
      setBoundaries(persona.boundaries ?? "");
      setCommunicationStyle(persona.communicationStyle ?? "");
      setExampleResponses(persona.exampleResponses ?? []);
      setPendingPresetId(undefined);
      setDirty(false);
    }
  }, [persona]);

  const handleSave = async () => {
    setSaving(true);
    await updatePersona({
      profile,
      directives,
      tone,
      boundaries,
      communicationStyle: communicationStyle || undefined,
      exampleResponses,
      ...(pendingPresetId !== undefined && { personalityPresetId: pendingPresetId }),
    });
    const { error: saveError } = usePersonaStore.getState();
    if (!saveError) {
      setDirty(false);
      setPendingPresetId(undefined);
    }
    setSaving(false);
  };

  const updateExample = (
    index: number,
    field: keyof ExampleResponse,
    value: string
  ) => {
    setExampleResponses((prev) =>
      prev.map((ex, i) => (i === index ? { ...ex, [field]: value } : ex))
    );
    setDirty(true);
  };

  const removeExample = (index: number) => {
    setExampleResponses((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const addExample = () => {
    if (exampleResponses.length >= 5) return;
    setExampleResponses((prev) => [...prev, { user: "", assistant: "" }]);
    setDirty(true);
  };

  return (
    <div className="flex flex-col gap-5">
      {loading && (
        <p className="text-xs text-muted-foreground">Loading...</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && persona && (
        <>
          {/* Core Identity & Values */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Core Identity & Values
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Who the AI is and how it should behave
            </p>
            <Textarea
              value={profile}
              onChange={(e) => {
                setProfile(e.target.value);
                setDirty(true);
              }}
              rows={5}
              maxLength={PERSONA_LIMITS.profile}
              placeholder="e.g., You are a senior developer who gives direct, practical advice..."
            />
          </div>

          {/* Tone */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Tone
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Keywords that describe the voice and feel
            </p>
            <Input
              value={tone}
              onChange={(e) => {
                setTone(e.target.value);
                setDirty(true);
              }}
              maxLength={PERSONA_LIMITS.tone}
              placeholder="e.g., direct, witty, warm, professional"
            />
          </div>

          {/* Communication Style */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Communication Style
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              How verbose responses should be
            </p>
            <div className="flex gap-2">
              {(["concise", "balanced", "detailed"] as const).map((style) => (
                <button
                  key={style}
                  onClick={() => {
                    setCommunicationStyle(
                      communicationStyle === style ? "" : style
                    );
                    setDirty(true);
                  }}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-all",
                    communicationStyle === style
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/50 text-muted-foreground hover:border-border hover:bg-muted/40"
                  )}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          {/* Boundaries */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Boundaries
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Things the AI should avoid doing
            </p>
            <Textarea
              value={boundaries}
              onChange={(e) => {
                setBoundaries(e.target.value);
                setDirty(true);
              }}
              rows={2}
              maxLength={PERSONA_LIMITS.boundaries}
              placeholder="e.g., Don't use emojis. Never apologize unnecessarily."
            />
          </div>

          {/* Example Responses */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Example Responses
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Show the AI how you want it to respond (max 5)
            </p>
            <div className="flex flex-col gap-3">
              {exampleResponses.map((ex, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/50 bg-muted/20 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      Example {i + 1}
                    </span>
                    <button
                      onClick={() => removeExample(i)}
                      className="text-[10px] text-muted-foreground/70 hover:text-destructive"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="mb-2">
                    <Label className="mb-1 block text-[10px] text-muted-foreground/70">
                      User message
                    </Label>
                    <Input
                      value={ex.user}
                      onChange={(e) => updateExample(i, "user", e.target.value)}
                      placeholder="What the user says..."
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-[10px] text-muted-foreground/70">
                      Assistant response
                    </Label>
                    <Textarea
                      value={ex.assistant}
                      onChange={(e) =>
                        updateExample(i, "assistant", e.target.value)
                      }
                      rows={2}
                      placeholder="How the AI should respond..."
                    />
                  </div>
                </div>
              ))}
              {exampleResponses.length < 5 && (
                <button
                  onClick={addExample}
                  className="rounded-lg border border-dashed border-border/50 px-3 py-2 text-xs text-muted-foreground hover:border-border hover:bg-muted/40"
                >
                  + Add example
                </button>
              )}
            </div>
          </div>

          {/* Directives */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Directives
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Operational rules — apply in both modes
            </p>
            <Textarea
              value={directives}
              onChange={(e) => {
                setDirectives(e.target.value);
                setDirty(true);
              }}
              rows={3}
              maxLength={PERSONA_LIMITS.directives}
              placeholder="e.g., Always respond in English. Keep responses under 200 words."
            />
          </div>

          {/* Save */}
          <Button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="self-start"
            size="sm"
          >
            {saving ? "Saving..." : "Save Changes"}
          </Button>

          <Separator />

          {/* Preset Templates */}
          <div>
            <Label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Personality Presets
            </Label>
            <p className="mb-2 text-[10px] text-muted-foreground/70">
              Apply a preset to fill in all personality fields
            </p>
            <div className="grid grid-cols-2 gap-2">
              {PERSONALITY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    setProfile(preset.profile);
                    setTone(preset.tone);
                    setCommunicationStyle(preset.communicationStyle);
                    setBoundaries(preset.boundaries);
                    setExampleResponses(preset.exampleResponses);
                    setPendingPresetId(preset.id);
                    setDirty(true);
                  }}
                  className="rounded-lg border border-border/50 px-3 py-2.5 text-left transition-all hover:border-border hover:bg-muted/40"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">
                      {preset.label}
                    </span>
                    <span
                      className={`rounded-full border px-1.5 py-px text-[8px] font-medium ${TAG_CONFIG[preset.tag].className}`}
                    >
                      {TAG_CONFIG[preset.tag].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {preset.tagline}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* System Prompt Preview */}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPreview(!showPreview)}
              className="px-0 text-[10px] text-muted-foreground hover:text-foreground"
            >
              {showPreview ? "Hide system prompt" : "Preview system prompt"}
            </Button>
            {showPreview && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {buildPreview(
                  profile,
                  directives,
                  tone,
                  communicationStyle,
                  boundaries,
                  exampleResponses
                )}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
