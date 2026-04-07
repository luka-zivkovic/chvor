import { useMemo } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { staggerContainer, staggerItem, phaseVariants } from "../onboarding-variants";
import { LANGUAGES } from "../onboarding-data";

interface Props {
  name: string;
  timezone: string;
  language: string;
  direction: number;
  onChangeName: (v: string) => void;
  onChangeTimezone: (v: string) => void;
  onChangeLanguage: (v: string) => void;
  onNext: () => void;
}

export function WelcomePhase({
  name, timezone, language, direction,
  onChangeName, onChangeTimezone, onChangeLanguage, onNext,
}: Props) {
  const timezones = useMemo(() => {
    try {
      return (Intl as any).supportedValuesOf("timeZone") as string[];
    } catch {
      return [
        "UTC", "America/New_York", "America/Chicago", "America/Denver",
        "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Europe/Paris",
        "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney",
      ];
    }
  }, []);

  return (
    <motion.div
      key="welcome"
      variants={phaseVariants}
      custom={direction}
      initial="enter"
      animate="center"
      exit="exit"
    >
      <motion.div variants={staggerContainer} initial="enter" animate="center" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Who are you?
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Just the basics so this feels like yours.
          </p>
        </motion.div>

        <motion.div variants={staggerItem}>
          <label htmlFor="onboard-name" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            What should I call you?
          </label>
          <Input
            id="onboard-name"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder="Your name"
            maxLength={100}
            className="bg-input/50 backdrop-blur-sm"
            autoFocus
          />
        </motion.div>

        <motion.div variants={staggerItem}>
          <label htmlFor="onboard-timezone" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Your timezone
          </label>
          <select
            id="onboard-timezone"
            value={timezone}
            onChange={(e) => onChangeTimezone(e.target.value)}
            className="w-full rounded-md border border-border bg-input/50 backdrop-blur-sm px-3 py-2 text-sm text-foreground"
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </motion.div>

        <motion.div variants={staggerItem}>
          <label htmlFor="onboard-language" className="mb-1.5 block text-xs font-medium text-muted-foreground">
            Preferred language
          </label>
          <select
            id="onboard-language"
            value={language}
            onChange={(e) => onChangeLanguage(e.target.value)}
            className="w-full rounded-md border border-border bg-input/50 backdrop-blur-sm px-3 py-2 text-sm text-foreground"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>{lang}</option>
            ))}
          </select>
        </motion.div>

        <motion.div variants={staggerItem} className="flex justify-end pt-2">
          <Button size="sm" onClick={onNext}>
            Continue
          </Button>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
