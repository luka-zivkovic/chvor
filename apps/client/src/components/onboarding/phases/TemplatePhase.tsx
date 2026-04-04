import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { TemplateManifest } from "@chvor/shared";
import type { RegistryEntryWithStatus } from "@/stores/registry-store";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";

interface Props {
  direction: number;
  onBack: () => void;
  onSkip: () => void;
  onSelectTemplate: (id: string, manifest: TemplateManifest) => void;
}

export function TemplatePhase({ direction, onBack, onSkip, onSelectTemplate }: Props) {
  const [templates, setTemplates] = useState<RegistryEntryWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingManifest, setLoadingManifest] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await api.registry.search({ kind: "template" });
        if (!cancelled) setTemplates(entries);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleSelect(entry: RegistryEntryWithStatus) {
    setLoadingManifest(entry.id);
    try {
      const manifest = await api.templates.getManifest(entry.id);
      onSelectTemplate(entry.id, manifest);
    } catch {
      setError(`Failed to load template "${entry.name}". Try again or skip.`);
      setLoadingManifest(null);
    }
  }

  return (
    <motion.div
      key="template"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Start with a template
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a pre-built agent template, or skip to configure from scratch.
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="max-h-[35vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              <span className="ml-2 text-sm text-muted-foreground">Loading templates...</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : templates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No templates available yet.
            </p>
          ) : (
            <div className="grid gap-2">
              {templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => handleSelect(t)}
                  disabled={loadingManifest !== null}
                  className="flex w-full items-start gap-3 rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm px-4 py-3 text-left transition-all hover:border-muted-foreground/30 hover:bg-muted/30 disabled:opacity-50"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                    {t.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{t.name}</span>
                      {t.author && (
                        <span className="text-[10px] text-muted-foreground">by {t.author}</span>
                      )}
                      {loadingManifest === t.id && (
                        <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                      {t.description}
                    </p>
                    {t.tags?.length ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {t.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-border/40 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </motion.div>

        <motion.div variants={staggerItem} className="flex items-center justify-between pt-2">
          <span className="text-[10px] text-muted-foreground">
            {templates.length} template{templates.length !== 1 ? "s" : ""} available
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
