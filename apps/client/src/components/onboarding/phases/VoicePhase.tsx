import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { VoiceSettingsContent } from "@/components/panels/VoiceSettingsContent";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";

interface Props {
  direction: number;
  onBack: () => void;
  onNext: () => void;
}

export function VoicePhase({ direction, onBack, onNext }: Props) {
  return (
    <motion.div
      key="voice"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Give it a voice
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose how your AI speaks and listens. You can change this later in settings.
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="max-h-[45vh] overflow-y-auto pr-1">
          <VoiceSettingsContent compact />
        </motion.div>

        <motion.div variants={staggerItem} className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
          <Button size="sm" onClick={onNext}>Next</Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
