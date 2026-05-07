import type { CommandTier, PcAction } from "@chvor/shared";

export interface PcSafetyAssessment {
  tier: CommandTier;
  reasons: string[];
  reasonDetails: Array<{ reason: string; tier: CommandTier }>;
  autoApprovableInSemiAutonomous: boolean;
}

const TIER_ORDER: Record<CommandTier, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
  blocked: 3,
};

function maxTier(a: CommandTier, b: CommandTier): CommandTier {
  return TIER_ORDER[b] > TIER_ORDER[a] ? b : a;
}

function normalizeKeyCombo(keys: string | undefined): string {
  return (keys ?? "").toLowerCase().replace(/\s+/g, "");
}

function hasBlockedShellDestructiveIntent(text: string): boolean {
  return /(:\(\)\s*\{[^}]*:\|:&?\s*\};?\s*:|rm\s+-[^\n;|&]*[rf][^\n;|&]*(?:\/|~|\$home|\*)|dd\s+.*of=\/dev\/|mkfs\b|diskutil\s+erase|format\s+[a-z]:|del\s+\/[sfq]+\s+[a-z]:\\)/i.test(
    text
  );
}

function classifyPcIntent(task: string): {
  tier: CommandTier;
  reasonDetails: Array<{ reason: string; tier: CommandTier }>;
} {
  const normalized = task.toLowerCase();
  const reasonDetails: Array<{ reason: string; tier: CommandTier }> = [];
  let tier: CommandTier = "safe";

  const mark = (nextTier: CommandTier, reason: string) => {
    tier = maxTier(tier, nextTier);
    reasonDetails.push({ tier: nextTier, reason });
  };

  if (hasBlockedShellDestructiveIntent(task)) {
    mark("blocked", "blocked destructive shell command intent");
  }
  if (
    /\b(format|wipe|erase)\b.*\b(disk|drive|filesystem|file system|partition|volume|computer|system|machine)\b/.test(
      normalized
    )
  ) {
    mark("blocked", "destructive whole-disk/system operation");
  }
  if (
    /\b(erase|wipe|destroy)\b.*\b(all|everything|entire|user files|files|home directory|home folder|disk|drive|filesystem|file system|system|windows|computer|machine)\b/.test(
      normalized
    )
  ) {
    mark("blocked", "broad destructive deletion intent");
  }
  if (
    /\b(delete|remove|erase|wipe|destroy)\b.*\b(all|every|everything|entire|whole)\b.*\b(files?|user files?|folders?|documents?|downloads?|photos?|pictures?|images?|videos?|music|media|home directory|home folder|disk|drive|filesystem|file system|system|windows|computer|machine)\b/.test(
      normalized
    ) ||
    /\b(delete|remove|erase|wipe|destroy)\b.*\b(?:my\s+)?(?:documents|downloads|desktop|photos|pictures|images|videos|music)(?:\s+(?:folder|directory|library))?\b/.test(
      normalized
    ) ||
    /\b(delete|remove|erase|wipe|destroy)\b.*\b(?:my\s+)?(?:user files|home directory|home folder|filesystem|file system)\b/.test(
      normalized
    ) ||
    /\b(delete|remove|erase|wipe|destroy)\b.*\b(?:my|the|this)\s+(?:computer|machine|disk|drive|system|windows installation)\b/.test(
      normalized
    )
  ) {
    mark("blocked", "broad destructive deletion intent");
  }
  if (
    /\bdelete\b.*\b(all|everything|entire)\b.*\b(files|user files|home directory|home folder|downloads|documents|desktop|system|windows|computer|drive|disk)\b/.test(
      normalized
    ) ||
    /\bdelete\b.*\b(user files|home directory|home folder|all files|everything on (?:my )?(?:computer|drive|disk))\b/.test(
      normalized
    )
  ) {
    mark("blocked", "broad destructive deletion intent");
  }
  if (/\b(factory reset|reinstall os|reset this pc)\b/.test(normalized)) {
    mark("blocked", "destructive OS reset intent");
  }

  if (
    /\b(password|passwords|keychain|1password|lastpass|bitwarden|passkey|credential|credentials|secret|api key|token)\b/.test(
      normalized
    )
  ) {
    mark("dangerous", "credential or secret handling intent");
  }
  if (
    /\b(send|submit|transfer|buy|purchase|checkout|pay|post|publish|tweet|email|message)\b/.test(
      normalized
    )
  ) {
    mark("dangerous", "external side-effect intent");
  }
  if (
    /\b(shutdown|reboot|restart computer|log out|sign out|lock screen|lock computer)\b/.test(
      normalized
    )
  ) {
    mark("dangerous", "session or power-state change intent");
  }
  if (
    /\b(delete|remove|close without saving|discard changes|empty trash|move to trash|uninstall|overwrite)\b/.test(
      normalized
    )
  ) {
    mark("dangerous", "destructive or data-loss intent");
  }

  return { tier, reasonDetails };
}

export function classifyPcAction(action: PcAction): { tier: CommandTier; reason: string } {
  switch (action.action) {
    case "screenshot":
    case "mouse_move":
    case "wait":
    case "scroll":
      return { tier: "safe", reason: `${action.action} is read-only/navigation-only` };

    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
      return { tier: "moderate", reason: `${action.action} can activate unknown UI controls` };

    case "type":
      if (action.text && hasBlockedShellDestructiveIntent(action.text)) {
        return { tier: "blocked", reason: "typing blocked destructive shell command text" };
      }
      return { tier: "moderate", reason: "typing changes focused UI state" };

    case "key": {
      const keys = normalizeKeyCombo(action.keys);
      if (
        [
          "escape",
          "esc",
          "tab",
          "shift+tab",
          "pagedown",
          "pageup",
          "ctrl+f",
          "ctrl+t",
          "meta+d",
          "alt+tab",
          "meta+down",
          "meta+up",
        ].includes(keys)
      ) {
        return { tier: "safe", reason: `${action.keys} is navigation/search/window focus only` };
      }
      if (["ctrl+c", "ctrl+a"].includes(keys)) {
        return {
          tier: "moderate",
          reason: `${action.keys} can expose or alter selected data/clipboard`,
        };
      }
      if (
        ["enter", "return", "ctrl+v", "ctrl+x", "ctrl+z", "ctrl+y", "ctrl+s", "ctrl+w"].includes(
          keys
        )
      ) {
        return { tier: "moderate", reason: `${action.keys} can change UI state or data` };
      }
      if (["alt+f4", "ctrl+shift+escape"].includes(keys)) {
        return {
          tier: "dangerous",
          reason: `${action.keys} can close apps or expose system controls`,
        };
      }
      return { tier: "moderate", reason: `${action.keys ?? "key"} has unknown side effects` };
    }
  }
}

export function assessPcTaskSafety(
  task: string,
  actions?: PcAction[] | null,
  options?: { routedActions?: boolean }
): PcSafetyAssessment {
  const reasonDetails: Array<{ reason: string; tier: CommandTier }> = [];
  let tier: CommandTier = "safe";

  const intent = classifyPcIntent(task);
  tier = maxTier(tier, intent.tier);
  reasonDetails.push(...intent.reasonDetails);

  if (actions) {
    for (const action of actions) {
      const actionAssessment = classifyPcAction(action);
      tier = maxTier(tier, actionAssessment.tier);
      reasonDetails.push({ tier: actionAssessment.tier, reason: actionAssessment.reason });
    }
  } else {
    tier = maxTier(tier, "moderate");
    reasonDetails.push({
      tier: "moderate",
      reason: "task requires LLM/a11y/vision planning before exact actions are known",
    });
  }

  const fallback = [{ tier: "safe" as const, reason: "safe low-impact PC navigation" }];
  const details = reasonDetails.length > 0 ? reasonDetails : fallback;

  return {
    tier,
    reasonDetails: details,
    reasons: details.map((detail) => detail.reason),
    autoApprovableInSemiAutonomous:
      tier === "safe" && !!actions && (options?.routedActions ?? true),
  };
}
