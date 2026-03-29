import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";

interface Props {
  direction: number;
  aiName: string;
  userName: string;
  onBack: () => void;
  onLaunch: () => void;
}

export function LaunchPhase({ direction, aiName, userName, onBack, onLaunch }: Props) {
  return (
    <motion.div
      key="launch"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div
        variants={staggerContainer}
        initial="enter"
        animate="center"
        className="flex flex-col items-center text-center space-y-4"
      >
        <motion.h2
          variants={staggerItem}
          className="text-3xl font-bold tracking-tight text-foreground"
        >
          {aiName || "Chvor"}
        </motion.h2>
        <motion.p variants={staggerItem} className="text-sm text-muted-foreground">
          is ready for you{userName ? `, ${userName}` : ""}.
        </motion.p>
        <motion.p
          variants={staggerItem}
          className="max-w-xs text-xs text-muted-foreground/60"
        >
          Everything you configured can be changed anytime in Settings.
          You can also set up a password in Settings &gt; Security.
        </motion.p>
        <motion.div variants={staggerItem} className="flex gap-3 pt-4">
          <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
          <Button
            size="sm"
            onClick={onLaunch}
            className="px-8 relative overflow-hidden"
          >
            <span className="relative z-10">Start</span>
          </Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
