import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PERSONALITY_PRESETS as PRESETS,
  TAG_CONFIG,
  type PersonalityTag,
} from "@/lib/personality-presets";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";

const ALL_TAGS: PersonalityTag[] = ["fun", "productivity", "balanced"];

interface Props {
  direction: number;
  selectedPreset: string | null;
  tagFilter: PersonalityTag | null;
  customProfile: string;
  showCustom: boolean;
  aiName: string;
  userNickname: string;
  name: string;
  onSelectPreset: (id: string) => void;
  onSetTagFilter: (tag: PersonalityTag | null) => void;
  onSetCustomProfile: (v: string) => void;
  onSetShowCustom: (v: boolean) => void;
  onSetAiName: (v: string) => void;
  onSetUserNickname: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}

export function PersonalityPhase({
  direction, selectedPreset, tagFilter, customProfile, showCustom,
  aiName, userNickname, name,
  onSelectPreset, onSetTagFilter, onSetCustomProfile, onSetShowCustom,
  onSetAiName, onSetUserNickname, onBack, onNext,
}: Props) {
  const canContinue = selectedPreset || customProfile.trim();

  return (
    <motion.div
      key="personality"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Shape its personality
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a vibe and give it a name. You can always change this later.
          </p>
        </motion.div>

        {/* Personality presets or custom */}
        {!showCustom ? (
          <motion.div variants={staggerItem} className="space-y-2">
            {/* Tag filter pills */}
            <div className="mb-3 flex gap-1.5">
              <button
                onClick={() => onSetTagFilter(null)}
                className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-all ${
                  tagFilter === null
                    ? "border-foreground/30 bg-foreground/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                All
              </button>
              {ALL_TAGS.map((t) => (
                <button
                  key={t}
                  onClick={() => onSetTagFilter(tagFilter === t ? null : t)}
                  className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-all ${
                    tagFilter === t
                      ? TAG_CONFIG[t].className
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {TAG_CONFIG[t].label}
                </button>
              ))}
            </div>

            {/* Preset cards */}
            <div className="max-h-[22vh] sm:max-h-[30vh] overflow-y-auto space-y-2 pr-1">
              {PRESETS.filter((p) => !tagFilter || p.tag === tagFilter).map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => onSelectPreset(preset.id)}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-all ${
                    selectedPreset === preset.id
                      ? "border-primary bg-primary/8 ring-1 ring-primary/30"
                      : "border-border/50 bg-card/30 backdrop-blur-sm hover:border-muted-foreground/30 hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{preset.label}</span>
                    <span className={`rounded-full border px-1.5 py-px text-[9px] font-medium ${TAG_CONFIG[preset.tag].className}`}>
                      {TAG_CONFIG[preset.tag].label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{preset.tagline}</p>
                </button>
              ))}

              <button
                onClick={() => { onSetShowCustom(true); onSelectPreset(""); }}
                className="w-full rounded-lg border border-dashed border-border px-4 py-3 text-left text-xs text-muted-foreground hover:border-primary/30 hover:text-foreground"
              >
                Write my own...
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div variants={staggerItem}>
            <Textarea
              value={customProfile}
              onChange={(e) => onSetCustomProfile(e.target.value)}
              rows={4}
              className="bg-input/50 backdrop-blur-sm"
              autoFocus
              placeholder="Describe how you want your AI to communicate..."
            />
            <button
              onClick={() => onSetShowCustom(false)}
              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Back to presets
            </button>
          </motion.div>
        )}

        {/* Naming section */}
        <motion.div variants={staggerItem} className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Name your AI
            </label>
            <Input
              value={aiName}
              onChange={(e) => onSetAiName(e.target.value)}
              placeholder="Chvor"
              className="bg-input/50 backdrop-blur-sm"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              How should it address you?
            </label>
            <Input
              value={userNickname}
              onChange={(e) => onSetUserNickname(e.target.value)}
              placeholder={name || "Boss, Chief, your name..."}
              className="bg-input/50 backdrop-blur-sm"
            />
          </div>
        </motion.div>

        <motion.div variants={staggerItem} className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
          <Button size="sm" onClick={onNext} disabled={!canContinue}>Next</Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
