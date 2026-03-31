import { useState, useCallback, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { usePersonaStore } from "@/stores/persona-store";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";
import type { PersonalityTag } from "@/lib/personality-presets";
import { OnboardingOrb } from "./OnboardingOrb";
import { WelcomePhase } from "./phases/WelcomePhase";
import { BrainPhase } from "./phases/BrainPhase";
import { PersonalityPhase } from "./phases/PersonalityPhase";
import { PowerUpPhase } from "./phases/PowerUpPhase";
import { VoicePhase } from "./phases/VoicePhase";
import { LaunchPhase } from "./phases/LaunchPhase";
import { PERSONALITY_COLORS } from "./onboarding-variants";

interface Props {
  onComplete: () => void;
}

export function OnboardingExperience({ onComplete }: Props) {
  const { updatePersona } = usePersonaStore();

  // Phase state
  const [phase, setPhase] = useState(0); // 0 = intro, 1-6 = phases
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

  // Phase 3: Personality
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<PersonalityTag | null>(null);
  const [customProfile, setCustomProfile] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [aiName, setAiName] = useState("Chvor");
  const [userNickname, setUserNickname] = useState("");

  // Derive personality color for orb
  const selectedPresetObj = PERSONALITY_PRESETS.find((p) => p.id === selectedPreset);
  const personalityColor = phase >= 3
    ? (showCustom && customProfile.trim()
        ? PERSONALITY_COLORS.custom
        : selectedPresetObj
          ? PERSONALITY_COLORS[selectedPresetObj.tag] ?? PERSONALITY_COLORS.balanced
          : undefined)
    : undefined;

  // Auto-advance from intro
  useEffect(() => {
    if (phase === 0) {
      const timer = setTimeout(() => {
        setDirection(1);
        setPhase(1);
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const goTo = useCallback((target: number) => {
    setPhase((prev) => {
      setDirection(target > prev ? 1 : -1);
      return target;
    });
  }, []);

  const resolvedProfile = showCustom
    ? customProfile
    : selectedPresetObj?.profile ?? "";

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      await updatePersona({
        profile: resolvedProfile,
        onboarded: true,
        name: name.trim() || undefined,
        timezone,
        language,
        aiName: aiName.trim() || undefined,
        userNickname: userNickname.trim() || undefined,
        personalityPresetId: selectedPreset ?? undefined,
        tone: selectedPresetObj?.tone ?? undefined,
        boundaries: selectedPresetObj?.boundaries ?? undefined,
        communicationStyle: selectedPresetObj?.communicationStyle ?? undefined,
        exampleResponses: selectedPresetObj?.exampleResponses ?? undefined,
      });
      // Wait for launch burst animation to complete
      launchTimerRef.current = setTimeout(() => onComplete(), 800);
    } catch {
      toast.error("Failed to save — please try again");
      setLaunching(false);
    }
  }, [
    updatePersona, resolvedProfile, name, timezone, language,
    aiName, userNickname, selectedPreset, selectedPresetObj, onComplete,
  ]);

  // Compute orb evolution level
  const orbEvolution = phase;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center bg-background overflow-hidden">
      {/* Subtle background gradient that warms with progress */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        animate={{
          background: `radial-gradient(ellipse at 50% 30%, ${
            phase <= 1
              ? "oklch(0.19 0.005 250 / 0.4)"
              : phase <= 3
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
          marginTop: phase === 0 ? "28vh" : phase === 6 ? "8vh" : "10vh",
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
        {phase === 0 && (
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
          {phase === 1 && (
            <WelcomePhase
              name={name}
              timezone={timezone}
              language={language}
              direction={direction}
              onChangeName={setName}
              onChangeTimezone={setTimezone}
              onChangeLanguage={setLanguage}
              onNext={() => goTo(2)}
            />
          )}
          {phase === 2 && (
            <BrainPhase
              direction={direction}
              onBack={() => goTo(1)}
              onNext={() => goTo(3)}
            />
          )}
          {phase === 3 && (
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
              onBack={() => goTo(2)}
              onNext={() => goTo(4)}
            />
          )}
          {phase === 4 && (
            <PowerUpPhase
              direction={direction}
              onBack={() => goTo(3)}
              onNext={() => goTo(5)}
            />
          )}
          {phase === 5 && (
            <VoicePhase
              direction={direction}
              onBack={() => goTo(4)}
              onNext={() => goTo(6)}
            />
          )}
          {phase === 6 && (
            <LaunchPhase
              direction={direction}
              aiName={aiName}
              userName={name}
              onBack={() => goTo(5)}
              onLaunch={handleLaunch}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
