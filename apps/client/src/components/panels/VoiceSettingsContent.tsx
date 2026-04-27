// apps/client/src/components/panels/VoiceSettingsContent.tsx
import { useEffect, useState } from "react";
import { useFeatureStore } from "@/stores/feature-store";
import type { VoiceProviderInfo, TtsMode } from "@/stores/feature-store";
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
    ttsSpeed,
    piperVoice,
    voiceStatus,
    models,
    fetchVoiceStatus,
    fetchModels,
    fetchVoiceConfig,
    updateSTTProvider,
    updateTTSProvider,
    updateTTSMode,
    updateTTSSpeed,
    updatePiperVoice,
    startModelDownload,
  } = useFeatureStore();

  useEffect(() => {
    fetchVoiceConfig();
    fetchVoiceStatus();
    fetchModels();
  }, [fetchVoiceConfig, fetchVoiceStatus, fetchModels]);

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

  const handleDownload = (modelId: string) => {
    startModelDownload(modelId);
  };

  // Piper voice models from the models list
  const piperModels = models.filter((m) => m.type === "tts" && m.id.startsWith("piper-"));

  // Language filter for voice browser
  const [langFilter, setLangFilter] = useState<string | null>(null);

  const filteredPiperModels = piperModels.filter((m) => {
    if (!langFilter) return true;
    const meta = m.meta;
    if (!meta?.language) return langFilter === "English";
    return meta.language === langFilter;
  });

  const languages = [...new Set(piperModels.map((m) => m.meta?.language ?? "English"))];

  const speedLabel = ttsSpeed <= 0.75 ? "Slower" : ttsSpeed >= 1.25 ? "Faster" : "Normal";

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
                  alt.id === "whisper-local" ? () => handleDownload("whisper-tiny-en") : undefined
                }
              />
            );
          })}
        </div>
      </div>

      {/* ── Text-to-Speech Provider ── */}
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
              />
            );
          })}
        </div>
      </div>

      {/* ── Piper Voice Browser (shown when Piper is selected or no provider set) ── */}
      {(ttsProvider === "piper" || (!ttsProvider && piperModels.some((m) => m.status === "ready"))) && piperModels.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
            Piper Voice
          </h3>
          <p className="text-[11px] text-muted-foreground/70 mb-2">
            Choose a voice for local speech synthesis
          </p>

          {/* Language filter tabs */}
          {languages.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              <button
                onClick={() => setLangFilter(null)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                  !langFilter ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                All
              </button>
              {languages.map((lang) => (
                <button
                  key={lang}
                  onClick={() => setLangFilter(lang)}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[10px] font-medium transition-all",
                    langFilter === lang ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {lang}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1.5 max-h-[30vh] overflow-y-auto pr-0.5">
            {filteredPiperModels.map((m) => {
              const meta = m.meta;
              const isActive = piperVoice === m.id || (!piperVoice && m.status === "ready" && m.id === "piper-lessac-medium");
              const isReady = m.status === "ready";
              const isDownloading = m.status === "downloading" || m.progress?.status === "downloading";

              return (
                <div
                  key={m.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => isReady && updatePiperVoice(m.id)}
                  onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && isReady) { e.preventDefault(); updatePiperVoice(m.id); } }}
                  className={cn(
                    "w-full rounded-lg border p-2.5 text-left transition-all",
                    isActive && isReady
                      ? "border-primary/60 bg-primary/5"
                      : isReady
                        ? "border-border/50 hover:border-border cursor-pointer"
                        : "border-border/30 opacity-70"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium text-foreground">{m.name}</span>
                        {meta?.language && (
                          <span className="rounded bg-muted/50 px-1 py-0.5 text-[8px] text-muted-foreground">
                            {meta.language}
                          </span>
                        )}
                        {meta?.gender && (
                          <span className="rounded bg-muted/50 px-1 py-0.5 text-[8px] text-muted-foreground">
                            {meta.gender}
                          </span>
                        )}
                        {meta?.quality && meta.quality !== "medium" && (
                          <span className={cn(
                            "rounded px-1 py-0.5 text-[8px]",
                            meta.quality === "high" ? "bg-yellow-500/15 text-yellow-500" : "bg-blue-500/15 text-blue-500"
                          )}>
                            {meta.quality}
                          </span>
                        )}
                        {isReady && (
                          <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-[8px] font-medium text-green-500">
                            Ready
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">{m.description}</p>
                    </div>

                    {isReady ? (
                      <div className={cn(
                        "mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 transition-colors",
                        isActive ? "border-primary bg-primary" : "border-muted-foreground/30"
                      )}>
                        {isActive && (
                          <svg viewBox="0 0 16 16" className="h-full w-full text-primary-foreground">
                            <path d="M6.5 11.5L3 8l1-1 2.5 2.5L11 5l1 1z" fill="currentColor" />
                          </svg>
                        )}
                      </div>
                    ) : (
                      <span className="shrink-0 text-[9px] text-muted-foreground">{m.sizeEstimate}</span>
                    )}
                  </div>

                  {/* Download progress */}
                  {isDownloading && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Downloading...</span>
                        <span>{m.progress?.percent ?? 0}%</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted/50">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${m.progress?.percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Download button */}
                  {!isReady && !isDownloading && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDownload(m.id); }}
                      className="mt-2 w-full rounded-md bg-primary/10 px-3 py-1.5 text-[10px] font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                    >
                      Download ({m.sizeEstimate})
                    </button>
                  )}

                  {/* Error */}
                  {m.progress?.status === "error" && (
                    <p className="mt-1 text-[10px] text-destructive">{m.progress.error ?? "Download failed"}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Speed Control ── */}
      {ttsProvider === "piper" && (
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-1">
            Speech Speed
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted-foreground w-8">0.5x</span>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={ttsSpeed}
              onChange={(e) => updateTTSSpeed(parseFloat(e.target.value))}
              className="flex-1 accent-primary h-1.5"
            />
            <span className="text-[10px] text-muted-foreground w-8 text-right">2.0x</span>
          </div>
          <p className="mt-1 text-center text-[10px] text-muted-foreground">
            {ttsSpeed.toFixed(1)}x — {speedLabel}
          </p>
        </div>
      )}

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
