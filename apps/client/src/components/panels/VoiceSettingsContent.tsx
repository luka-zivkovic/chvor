// apps/client/src/components/panels/VoiceSettingsContent.tsx
import { useEffect } from "react";
import { useVoiceStore } from "@/stores/voice-store";
import type { VoiceProviderInfo, TtsMode } from "@/stores/voice-store";
import { cn } from "@/lib/utils";

// ── Provider Card ─────────────────────────────────────────────

function ProviderCard({
  provider,
  selected,
  onSelect,
  onDownload,
}: {
  provider: VoiceProviderInfo & { progress?: { status: string; percent: number; error?: string } };
  selected: boolean;
  onSelect: () => void;
  onDownload?: () => void;
}) {
  const needsDownload = provider.modelStatus === "not_downloaded";
  const downloading = provider.modelStatus === "downloading" || provider.progress?.status === "downloading";
  const hasError = provider.progress?.status === "error";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-all cursor-pointer",
        selected
          ? "border-primary/60 bg-primary/5"
          : "border-border/50 hover:border-border"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{provider.name}</span>
            {provider.available && !needsDownload && (
              <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[9px] font-medium text-green-500">
                Ready
              </span>
            )}
            {provider.needsCredential && (
              <span className="rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[9px] font-medium text-yellow-500">
                Needs API key
              </span>
            )}
            {needsDownload && !downloading && (
              <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-500">
                Download required
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">
            {provider.description}
          </p>
        </div>
        <div
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
            selected ? "border-primary bg-primary" : "border-muted-foreground/30"
          )}
        >
          {selected && (
            <svg viewBox="0 0 16 16" className="h-full w-full text-primary-foreground">
              <path d="M6.5 11.5L3 8l1-1 2.5 2.5L11 5l1 1z" fill="currentColor" />
            </svg>
          )}
        </div>
      </div>

      {/* Download progress */}
      {downloading && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
            <span>Downloading...</span>
            <span>{provider.progress?.percent ?? 0}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted/50">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${provider.progress?.percent ?? 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Download button for local models */}
      {needsDownload && !downloading && onDownload && selected && (
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          className="mt-2 w-full rounded-md bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
        >
          Download Model
        </button>
      )}

      {/* Error */}
      {hasError && (
        <p className="mt-2 text-[10px] text-destructive">
          {provider.progress?.error ?? "Download failed"}
        </p>
      )}
    </div>
  );
}

// ── TTS Mode Selector ─────────────────────────────────────────

const TTS_MODES: { id: TtsMode; label: string; description: string }[] = [
  { id: "inbound", label: "Voice replies only", description: "Speak back when you speak to it" },
  { id: "always", label: "Always speak", description: "Read every response aloud" },
  { id: "off", label: "Off", description: "Text only, no voice output" },
];

// ── Main Component ────────────────────────────────────────────

interface Props {
  compact?: boolean; // Compact mode for onboarding
}

export function VoiceSettingsContent({ compact }: Props) {
  const {
    sttProvider,
    ttsProvider,
    ttsMode,
    voiceStatus,
    models,
    fetchVoiceStatus,
    fetchModels,
    fetchConfig,
    updateSTTProvider,
    updateTTSProvider,
    updateTTSMode,
    startModelDownload,
  } = useVoiceStore();

  useEffect(() => {
    fetchConfig();
    fetchVoiceStatus();
    fetchModels();
  }, [fetchConfig, fetchVoiceStatus, fetchModels]);

  const sttAlternatives = voiceStatus?.stt?.alternatives ?? [];
  const ttsProviders = voiceStatus?.tts?.providers ?? [];

  // Merge model progress into provider info
  const enrichProvider = (p: VoiceProviderInfo) => {
    const model = models.find(
      (m) =>
        (m.type === "stt" && p.id === "whisper-local") ||
        (m.type === "tts" && p.id === "piper")
    );
    return {
      ...p,
      modelStatus: model?.status ?? p.modelStatus,
      progress: model?.progress,
    };
  };

  const handleDownload = (providerId: string) => {
    if (providerId === "whisper-local") startModelDownload("whisper-tiny-en");
    if (providerId === "piper") startModelDownload("piper-lessac-medium");
  };

  return (
    <div className="flex flex-col gap-5">
      {/* ── Speech-to-Text ── */}
      <div>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
          Speech to Text
        </h3>
        <p className="text-[11px] text-muted-foreground/70 mb-3">
          How your voice is converted to text
        </p>
        <div className="flex flex-col gap-1.5">
          {sttAlternatives.map((alt) => {
            const enriched = enrichProvider(alt);
            return (
              <ProviderCard
                key={alt.id}
                provider={enriched}
                selected={sttProvider === alt.id}
                onSelect={() => updateSTTProvider(alt.id)}
                onDownload={
                  alt.id === "whisper-local" ? () => handleDownload(alt.id) : undefined
                }
              />
            );
          })}
        </div>
      </div>

      {/* ── Text-to-Speech ── */}
      <div>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
          Text to Speech
        </h3>
        <p className="text-[11px] text-muted-foreground/70 mb-3">
          How Chvor speaks back to you
        </p>
        <div className="flex flex-col gap-1.5">
          {ttsProviders.map((p) => {
            const enriched = enrichProvider(p);
            return (
              <ProviderCard
                key={p.id}
                provider={enriched}
                selected={ttsProvider === p.id}
                onSelect={() => updateTTSProvider(p.id)}
                onDownload={
                  p.id === "piper" ? () => handleDownload(p.id) : undefined
                }
              />
            );
          })}
        </div>
      </div>

      {/* ── TTS Mode ── */}
      {!compact && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
            Voice Output Mode
          </h3>
          <div className="flex flex-col gap-1.5">
            {TTS_MODES.map((mode) => (
              <button
                key={mode.id}
                onClick={() => updateTTSMode(mode.id)}
                className={cn(
                  "w-full rounded-lg border p-2.5 text-left transition-all",
                  ttsMode === mode.id
                    ? "border-primary/60 bg-primary/5"
                    : "border-border/50 hover:border-border"
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium text-foreground">{mode.label}</span>
                    <p className="text-[11px] text-muted-foreground">{mode.description}</p>
                  </div>
                  <div
                    className={cn(
                      "h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
                      ttsMode === mode.id ? "border-primary bg-primary" : "border-muted-foreground/30"
                    )}
                  >
                    {ttsMode === mode.id && (
                      <svg viewBox="0 0 16 16" className="h-full w-full text-primary-foreground">
                        <path d="M6.5 11.5L3 8l1-1 2.5 2.5L11 5l1 1z" fill="currentColor" />
                      </svg>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
