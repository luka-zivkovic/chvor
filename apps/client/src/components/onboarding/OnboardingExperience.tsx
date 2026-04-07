import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { usePersonaStore } from "@/stores/persona-store";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import type { PersonalityTag } from "@/lib/personality-presets";
import type { TemplateManifest } from "@chvor/shared";
import { api } from "@/lib/api";
import { OnboardingOrb } from "./OnboardingOrb";
import { WelcomePhase } from "./phases/WelcomePhase";
import { TemplatePhase } from "./phases/TemplatePhase";
import { BrainPhase } from "./phases/BrainPhase";
import { PersonalityPhase } from "./phases/PersonalityPhase";
import { PowerUpPhase } from "./phases/PowerUpPhase";
import { VoicePhase } from "./phases/VoicePhase";
import { LaunchPhase } from "./phases/LaunchPhase";
import { PERSONALITY_COLORS } from "./onboarding-variants";

// Phase IDs for dynamic sequencing
type PhaseId = "intro" | "welcome" | "template" | "brain" | "personality" | "powerup" | "voice" | "launch";

interface Props {
  onComplete: () => void;
}

export function OnboardingExperience({ onComplete }: Props) {
  const { updatePersona } = usePersonaStore();

  // Phase state — now tracks PhaseId instead of raw index
  const [currentPhase, setCurrentPhase] = useState<PhaseId>("intro");
  const [direction, setDirection] = useState(1);
  const [launching, setLaunching] = useState(false);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup launch timer on unmount
  useEffect(() => {
    return () => {
      if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    };
  }, []);

  // Phase 1: Identity
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [language, setLanguage] = useState("English");

  // Phase 2: Template selection
  const [selectedTemplate, setSelectedTemplate] = useState<{ id: string; manifest: TemplateManifest } | null>(null);
  const [templateEntries, setTemplateEntries] = useState<Awaited<ReturnType<typeof api.registry.search>> | null>(null);
  const [templateEntriesError, setTemplateEntriesError] = useState<string | null>(null);

  // Pre-fetch templates once so TemplatePhase doesn't re-fetch on every mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const entries = await api.registry.search({ kind: "template" });
        if (!cancelled) setTemplateEntries(entries);
      } catch (err) {
        if (!cancelled) setTemplateEntriesError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Phase 4: Personality
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<PersonalityTag | null>(null);
  const [customProfile, setCustomProfile] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [aiName, setAiName] = useState("Chvor");
  const [userNickname, setUserNickname] = useState("");

  // Dynamic phase sequence — skip personality if template defines persona
  const phaseSequence = useMemo<PhaseId[]>(() => {
    const phases: PhaseId[] = ["intro", "welcome", "template", "brain"];
    if (!selectedTemplate?.manifest.persona) {
      phases.push("personality");
    }
    phases.push("powerup", "voice", "launch");
    return phases;
  }, [selectedTemplate]);

  const phaseIndex = phaseSequence.indexOf(currentPhase);

  // Derive personality color for orb
  const selectedPresetObj = PERSONALITY_PRESETS.find((p) => p.id === selectedPreset);
  const personalityPhaseIdx = phaseSequence.indexOf("personality");
  const personalityColor = (personalityPhaseIdx !== -1 && phaseIndex >= personalityPhaseIdx)
    ? (showCustom && customProfile.trim()
        ? PERSONALITY_COLORS.custom
        : selectedPresetObj
          ? PERSONALITY_COLORS[selectedPresetObj.tag] ?? PERSONALITY_COLORS.balanced
          : undefined)
    : undefined;

  // Auto-advance from intro
  useEffect(() => {
    if (currentPhase === "intro") {
      const timer = setTimeout(() => {
        setDirection(1);
        setCurrentPhase("welcome");
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [currentPhase]);

  const goTo = useCallback((target: PhaseId) => {
    setCurrentPhase((prev) => {
      const prevIdx = phaseSequence.indexOf(prev);
      const targetIdx = phaseSequence.indexOf(target);
      setDirection(targetIdx > prevIdx ? 1 : -1);
      return target;
    });
  }, [phaseSequence]);

  const goNext = useCallback(() => {
    const idx = phaseSequence.indexOf(currentPhase);
    if (idx < phaseSequence.length - 1) goTo(phaseSequence[idx + 1]);
  }, [currentPhase, phaseSequence, goTo]);

  const goBack = useCallback(() => {
    const idx = phaseSequence.indexOf(currentPhase);
    if (idx > 0) goTo(phaseSequence[idx - 1]);
  }, [currentPhase, phaseSequence, goTo]);

  const resolvedProfile = showCustom
    ? customProfile
    : selectedPresetObj?.profile ?? "";

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      // If a template was selected, install it first (skipPersona: onboarding applies merged persona below)
      let templateInstalled = false;
      if (selectedTemplate) {
        try {
          await api.registry.install(selectedTemplate.id, "template", { skipPersona: true });
          templateInstalled = true;
        } catch {
          toast.error("Template installation failed — launching without it");
        }
      }

      // Only use template persona data if the template actually installed
      const tPersona = templateInstalled ? selectedTemplate?.manifest.persona : undefined;

      await updatePersona({
        profile: tPersona?.profile ?? resolvedProfile,
        onboarded: true,
        name: name.trim() || undefined,
        timezone,
        language,
        aiName: (tPersona?.aiName ?? aiName.trim()) || undefined,
        userNickname: userNickname.trim() || undefined,
        personalityPresetId: tPersona ? undefined : selectedPreset ?? undefined,
        tone: tPersona?.tone ?? selectedPresetObj?.tone ?? undefined,
        boundaries: tPersona?.boundaries ?? selectedPresetObj?.boundaries ?? undefined,
        communicationStyle: tPersona?.communicationStyle ?? selectedPresetObj?.communicationStyle ?? undefined,
        exampleResponses: tPersona?.exampleResponses ?? selectedPresetObj?.exampleResponses ?? undefined,
      });
      // Wait for launch burst animation to complete
      launchTimerRef.current = setTimeout(() => onComplete(), 800);
    } catch {
      toast.error("Failed to save — please try again");
      setLaunching(false);
    }
  }, [
    updatePersona, resolvedProfile, name, timezone, language,
    aiName, userNickname, selectedPreset, selectedPresetObj,
    selectedTemplate, onComplete,
  ]);

  // Compute orb evolution level — maps sequence position to 0-based index
  const orbEvolution = phaseIndex;

  // For the launch phase orb position, check if we're on the last phase
  const isLaunch = currentPhase === "launch";
  const isIntro = currentPhase === "intro";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center bg-background overflow-hidden">
      {/* Subtle background gradient that warms with progress */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{
          background: `radial-gradient(ellipse at 50% 30%, ${
            phaseIndex <= 1
              ? "oklch(0.19 0.005 250 / 0.4)"
              : phaseIndex <= 3
                ? "oklch(0.20 0.01 250 / 0.5)"
                : "oklch(0.21 0.015 250 / 0.6)"
          } 0%, oklch(0.17 0 0) 60%)`,
        }}
        transition={{ duration: 1.5, ease: "easeInOut" }}
      />

      {/* Orb — always visible, positioned in upper area */}
      <motion.div
        className="relative z-10 flex items-center justify-center"
        style={{ marginTop: "10vh" }}
        animate={{
          marginTop: isIntro ? "28vh" : isLaunch ? "8vh" : "10vh",
        }}
        transition={{ type: "spring", stiffness: 80, damping: 20 }}
      >
        <OnboardingOrb
          evolution={orbEvolution}
          personalityColor={personalityColor}
          launching={launching}
        />
      </motion.div>

      {/* Phase 0: Intro — wordmark */}
      <AnimatePresence>
        {isIntro && (
          <motion.div
            key="intro-wordmark"
            className="relative z-10 mt-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.4 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1 }}
          >
            <span className="text-lg font-semibold tracking-[0.3em] text-foreground/40">
              chvor
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Phase content panel */}
      <div className="relative z-10 mt-6 w-full max-w-2xl px-4 sm:px-6">
        <AnimatePresence mode="wait" custom={direction}>
          {currentPhase === "welcome" && (
            <WelcomePhase
              name={name}
              timezone={timezone}
              language={language}
              direction={direction}
              onChangeName={setName}
              onChangeTimezone={setTimezone}
              onChangeLanguage={setLanguage}
              onNext={goNext}
            />
          )}
          {currentPhase === "template" && (
            <TemplatePhase
              direction={direction}
              prefetchedTemplates={templateEntries}
              prefetchedError={templateEntriesError}
              onBack={goBack}
              onSkip={() => { setSelectedTemplate(null); goNext(); }}
              onSelectTemplate={(id, manifest) => {
                setSelectedTemplate({ id, manifest });
                // If template has an AI name, use it
                if (manifest.persona?.aiName) {
                  setAiName(manifest.persona.aiName);
                }
                goNext();
              }}
            />
          )}
          {currentPhase === "brain" && (
            <BrainPhase
              direction={direction}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {currentPhase === "personality" && (
            <PersonalityPhase
              direction={direction}
              selectedPreset={selectedPreset}
              tagFilter={tagFilter}
              customProfile={customProfile}
              showCustom={showCustom}
              aiName={aiName}
              userNickname={userNickname}
              name={name}
              onSelectPreset={(id) => { setSelectedPreset(id); setShowCustom(false); }}
              onSetTagFilter={setTagFilter}
              onSetCustomProfile={setCustomProfile}
              onSetShowCustom={setShowCustom}
              onSetAiName={setAiName}
              onSetUserNickname={setUserNickname}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {currentPhase === "powerup" && (
            <PowerUpPhase
              direction={direction}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {currentPhase === "voice" && (
            <VoicePhase
              direction={direction}
              onBack={goBack}
              onNext={goNext}
            />
          )}
          {currentPhase === "launch" && (
            <LaunchPhase
              direction={direction}
              aiName={selectedTemplate?.manifest.persona?.aiName ?? aiName}
              userName={name}
              launching={launching}
              onBack={goBack}
              onLaunch={handleLaunch}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
