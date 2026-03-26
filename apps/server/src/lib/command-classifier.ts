export type CommandTier = "safe" | "moderate" | "dangerous" | "blocked";

export interface ClassificationResult {
  tier: CommandTier;
  subCommands: Array<{ command: string; tier: CommandTier }>;
}

// ---------------------------------------------------------------------------
// Blocked patterns — never allowed, checked first
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: RegExp[] = [
  /:\(\)\s*\{[^}]*:\|:&?\s*\};?\s*:/, // fork bomb (relaxed whitespace)
  />\s*\/dev\/(?:sd[a-z]|nvme|vd[a-z]|mmcblk|xvd[a-z])/i, // raw disk write (expanded devices)
  /dd\s+.*of=\/dev\//i, // dd to device
  /rm\s+-[rf]*\s+\/\s*$/i, // rm -rf /
  /rm\s+-[rf]*\s+\/\s+/i, // rm -rf / <something>
  /rm\s+-[rf]*\s+\/\*/i, // rm -rf /* (globbed variant)
  /format\s+[a-zA-Z]:/i, // format C: (case-insensitive)
  /del\s+\/[sfq]+\s+[a-zA-Z]:\\/i, // del /s /q C:\ (case-insensitive)
  /mkfs\s+\/dev\//i, // mkfs on device
];

export function isBlocked(command: string): boolean {
  return BLOCKED_PATTERNS.some((p) => p.test(command));
}

// ---------------------------------------------------------------------------
// Command tier sets (lowercase)
// ---------------------------------------------------------------------------

const SAFE_COMMANDS = new Set([
  "ls", "dir", "cat", "type", "pwd", "whoami", "echo", "which", "where",
  "ps", "df", "uname", "hostname", "date", "head", "tail",
  "grep", "find", "wc", "file", "stat", "id", "uptime",
  "tree", "less", "more", "sort", "uniq", "diff", "basename", "dirname",
  "realpath", "readlink", "true", "false", "test", "expr",
  // PowerShell
  "get-childitem", "get-content", "get-process", "get-location",
  "get-date", "get-host", "select-string", "measure-object",
  "test-path", "get-item", "get-itemproperty", "get-command",
  "get-help", "get-alias", "get-variable", "get-service",
  "get-eventlog", "get-counter", "get-netadapter",
]);

const MODERATE_COMMANDS = new Set([
  "env", "set", "printenv", // reveal env vars — require approval
  "mkdir", "cp", "mv", "touch", "chmod", "chown", "ln",
  "npm", "npx", "yarn", "pnpm", "pip", "pip3", "brew", "apt", "apt-get",
  "git", "curl", "wget", "tar", "unzip", "zip",
  "docker", "docker-compose", "node", "python", "python3",
  "claude",
  "ssh", "scp", "rsync",
  // PowerShell
  "new-item", "copy-item", "move-item", "set-content", "add-content",
  "invoke-webrequest", "invoke-restmethod", "expand-archive",
  "compress-archive", "start-process", "set-itemproperty",
]);

const DANGEROUS_COMMANDS = new Set([
  "rm", "rmdir", "del", "erase",
  "sudo", "su", "runas", "doas",
  "kill", "killall", "pkill", "taskkill",
  "shutdown", "reboot", "halt", "poweroff",
  "format", "diskpart", "fdisk", "mkfs",
  "iptables", "ufw", "firewall-cmd",
  "reg", "regedit",
  "net", "netsh",
  "dd",
  // PowerShell
  "remove-item", "stop-process", "restart-computer", "stop-computer",
  "clear-content", "set-executionpolicy",
]);

// ---------------------------------------------------------------------------
// Tier ordering (for "highest tier wins")
// ---------------------------------------------------------------------------

const TIER_RANK: Record<CommandTier, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
  blocked: 3,
};

function highestTier(a: CommandTier, b: CommandTier): CommandTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Command splitting and extraction
// ---------------------------------------------------------------------------

/** Split a shell command string on &&, ||, ;, | (respecting quoted strings) */
function splitShellCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
    } else if (!inSingle && !inDouble) {
      // Check for &&, ||, ;, |
      if (command[i] === "&" && command[i + 1] === "&") {
        parts.push(current.trim());
        current = "";
        i += 2;
      } else if (command[i] === "|" && command[i + 1] === "|") {
        parts.push(current.trim());
        current = "";
        i += 2;
      } else if (command[i] === ";") {
        parts.push(current.trim());
        current = "";
        i++;
      } else if (command[i] === "|") {
        parts.push(current.trim());
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    } else {
      current += ch;
      i++;
    }
  }

  if (current.trim()) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

/** Extract the command name (first token) from a sub-command, strip path prefix */
function extractCommandName(subCommand: string): string {
  // Remove leading env vars like VAR=val
  let cmd = subCommand;
  while (/^\w+=\S+\s/.test(cmd)) {
    cmd = cmd.replace(/^\w+=\S+\s+/, "");
  }

  const firstToken = cmd.split(/\s+/)[0] ?? "";
  // Strip path prefix: /usr/bin/rm → rm, C:\Windows\System32\cmd.exe → cmd.exe → cmd
  const basename = firstToken.split("/").pop()?.split("\\").pop() ?? firstToken;
  // Strip .exe, .cmd, .bat extensions
  return basename.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function classifySingle(commandName: string): CommandTier {
  if (SAFE_COMMANDS.has(commandName)) return "safe";
  if (MODERATE_COMMANDS.has(commandName)) return "moderate";
  if (DANGEROUS_COMMANDS.has(commandName)) return "dangerous";
  return "dangerous"; // unknown defaults to dangerous — show red card for unrecognized binaries
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Detect command substitution ($(...) or backticks) — escalate to dangerous since we can't reliably parse nested commands */
const SUBSHELL_PATTERN = /\$\(|`[^`]+`/;

export function classifyCommand(command: string): ClassificationResult {
  if (isBlocked(command)) {
    return { tier: "blocked", subCommands: [{ command, tier: "blocked" }] };
  }

  const parts = splitShellCommand(command);
  if (parts.length === 0) {
    return { tier: "safe", subCommands: [] };
  }

  const subCommands = parts.map((part) => {
    const name = extractCommandName(part);
    let tier = classifySingle(name);
    // Escalate if sub-command contains command substitution
    if (SUBSHELL_PATTERN.test(part) && TIER_RANK[tier] < TIER_RANK["dangerous"]) {
      tier = "dangerous";
    }
    return { command: part, tier };
  });

  let overall: CommandTier = "safe";
  for (const sub of subCommands) {
    overall = highestTier(overall, sub.tier);
  }

  return { tier: overall, subCommands };
}
