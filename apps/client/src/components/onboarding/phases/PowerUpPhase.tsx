import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { AddCredentialDialog } from "@/components/credentials/AddCredentialDialog";
import { useCredentialStore } from "@/stores/credential-store";
import { SKILL_CATALOG, CATEGORY_LABELS, CATEGORY_ORDER, type SkillEntry } from "../onboarding-data";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";
import { api } from "@/lib/api";
import type { RegistryEntry } from "@chvor/shared";

type FeaturedEntry = RegistryEntry & { installed: boolean; installedVersion: string | null };

interface Props {
  direction: number;
  onBack: () => void;
  onNext: () => void;
}

export function PowerUpPhase({ direction, onBack, onNext }: Props) {
  const { credentials, fetchAll: fetchCredentials } = useCredentialStore();
  const [setupCredType, setSetupCredType] = useState<string | null>(null);

  // Registry featured entries
  const [featuredEntries, setFeaturedEntries] = useState<FeaturedEntry[]>([]);
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());

  const fetchFeatured = useCallback(async () => {
    try {
      const entries = await api.registry.featured();
      setFeaturedEntries(entries);
    } catch {
      // Registry may not be reachable — silently skip
    }
  }, []);

  useEffect(() => { fetchCredentials(); }, [fetchCredentials]);
  useEffect(() => { fetchFeatured(); }, [fetchFeatured]);

  const credTypeSet = new Set(credentials.map((c) => c.type));

  const isSkillActive = (skill: SkillEntry): boolean => {
    if (skill.comingSoon) return false;
    if (!skill.credType) return true;
    return credTypeSet.has(skill.credType);
  };

  const handleInstallEntry = async (entry: FeaturedEntry) => {
    if (entry.installed || installingIds.has(entry.id)) return;
    setInstallingIds((prev) => new Set(prev).add(entry.id));
    try {
      await api.registry.install(entry.id, entry.kind);
      setFeaturedEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, installed: true } : e)),
      );
    } catch {
      // Silently fail — user can install later from registry browser
    } finally {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  const configurableSkills = SKILL_CATALOG.filter((s) => !s.comingSoon);
  const activeSkillCount = configurableSkills.filter(isSkillActive).length;
  const installedRegistryCount = featuredEntries.filter((e) => e.installed).length;

  return (
    <motion.div
      key="powerup"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Power it up
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect integrations to extend what your AI can do. You can always add more later.
          </p>
        </motion.div>

        {setupCredType ? (
          <motion.div variants={staggerItem}>
            <AddCredentialDialog
              initialCredType={setupCredType}
              onClose={() => { setSetupCredType(null); fetchCredentials(); }}
            />
          </motion.div>
        ) : (
          <motion.div variants={staggerItem} className="space-y-4 max-h-[45vh] overflow-y-auto pr-1">
            {/* Registry Skills — recommended from the community registry */}
            {featuredEntries.length > 0 && (
              <div>
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Recommended Skills
                </h3>
                <div className="grid grid-cols-4 gap-2">
                  {featuredEntries.map((entry) => {
                    const installed = entry.installed;
                    const installing = installingIds.has(entry.id);
                    return (
                      <button
                        key={`registry-${entry.id}`}
                        onClick={() => handleInstallEntry(entry)}
                        disabled={installed || installing}
                        className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-all ${
                          installed
                            ? "border-green-500/20 bg-green-500/5"
                            : installing
                              ? "border-blue-500/20 bg-blue-500/5 animate-pulse"
                              : "border-border/50 bg-card/30 backdrop-blur-sm hover:border-muted-foreground/30 hover:bg-muted/30"
                        }`}
                      >
                        <ProviderIcon icon={entry.category ?? entry.kind} size={22} className="text-muted-foreground" />
                        <span className="text-[11px] font-medium text-foreground">{entry.name}</span>
                        {installed && <span className="text-[9px] text-green-400">Installed</span>}
                        {installing && <span className="text-[9px] text-blue-400">Installing...</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Featured integrations (credential-based) */}
            <div>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Popular Integrations
              </h3>
              <div className="grid grid-cols-4 gap-2">
                {SKILL_CATALOG.filter((s) => s.featured).map((skill) => {
                  const active = isSkillActive(skill);
                  return (
                    <button
                      key={`featured-${skill.id}`}
                      onClick={() => !active && skill.credType && setSetupCredType(skill.credType)}
                      disabled={active}
                      className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-all ${
                        active
                          ? "border-green-500/20 bg-green-500/5"
                          : "border-border/50 bg-card/30 backdrop-blur-sm hover:border-muted-foreground/30 hover:bg-muted/30"
                      }`}
                    >
                      <ProviderIcon icon={skill.icon ?? skill.id} size={22} className="text-muted-foreground" />
                      <span className="text-[11px] font-medium text-foreground">{skill.label}</span>
                      {active && <span className="text-[9px] text-green-400">Active</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Categorized list */}
            {CATEGORY_ORDER.map((cat) => {
              const skills = configurableSkills.filter((s) => s.category === cat);
              if (skills.length === 0) return null;
              return (
                <div key={cat}>
                  <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                  <div className="space-y-1.5">
                    {skills.map((skill) => {
                      const active = isSkillActive(skill);
                      const soon = skill.comingSoon;
                      return (
                        <button
                          key={skill.id}
                          onClick={() => !active && !soon && skill.credType && setSetupCredType(skill.credType)}
                          disabled={active || soon}
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-all ${
                            soon
                              ? "border-border/30 opacity-40"
                              : active
                                ? "border-green-500/20 bg-green-500/5"
                                : "border-border/50 bg-card/30 backdrop-blur-sm hover:border-muted-foreground/30 hover:bg-muted/30"
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <ProviderIcon icon={skill.icon ?? skill.id} size={18} className="shrink-0 text-muted-foreground" />
                            <div>
                              <span className="text-sm font-medium text-foreground">{skill.label}</span>
                              <p className="text-[11px] text-muted-foreground">{skill.description}</p>
                            </div>
                          </div>
                          {soon ? (
                            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[9px] text-muted-foreground">Soon</span>
                          ) : active ? (
                            <span className="shrink-0 text-[10px] text-green-400">Active</span>
                          ) : (
                            <span className="shrink-0 text-[10px] text-muted-foreground">Set up</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </motion.div>
        )}

        {!setupCredType && (
          <motion.div variants={staggerItem} className="flex items-center justify-between pt-2">
            <span className="text-[10px] text-muted-foreground">
              {activeSkillCount + installedRegistryCount} active
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
              <Button size="sm" onClick={onNext}>Next</Button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
