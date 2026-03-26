/**
 * Prevents the OS from sleeping while the Chvor agent is running.
 *
 * - Windows:  Periodically calls SetThreadExecutionState via PowerShell
 * - macOS:    Spawns `caffeinate -i -s` (idle + system sleep prevention)
 * - Linux:    Spawns `systemd-inhibit` (idle + sleep inhibition)
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

const WINDOWS_INTERVAL_MS = 30_000; // reset idle timer every 30s

let timer: ReturnType<typeof setInterval> | null = null;
let childProc: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// Platform-specific helpers
// ---------------------------------------------------------------------------

/** Windows: call SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) */
function startWindows(): void {
  const ps = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class KeepAwake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f); }'; [KeepAwake]::SetThreadExecutionState(2147483649)`;

  const tick = () => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], (err) => {
      if (err) console.error("[keep-awake] powershell tick failed:", err.message);
    });
  };

  tick(); // immediate first call
  timer = setInterval(tick, WINDOWS_INTERVAL_MS);
}

/** Release the Windows keep-awake state */
function stopWindows(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Clear ES_CONTINUOUS by calling with ES_CONTINUOUS alone (0x80000000)
  const release = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class KeepAwake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f); }'; [KeepAwake]::SetThreadExecutionState(2147483648)`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", release], (err) => {
    if (err) console.error("[keep-awake] release failed:", err.message);
  });
}

/** macOS: caffeinate prevents idle (-i) and system (-s) sleep */
function startDarwin(): void {
  childProc = spawn("caffeinate", ["-i", "-s"], {
    stdio: "ignore",
    detached: false,
  });
  childProc.on("error", (err) => {
    console.error("[keep-awake] caffeinate failed:", err.message);
    childProc = null;
  });
}

/** Linux: systemd-inhibit blocks idle and sleep */
function startLinux(): void {
  childProc = spawn(
    "systemd-inhibit",
    ["--what=idle:sleep", "--who=chvor", "--why=Agent running", "--mode=block", "sleep", "infinity"],
    { stdio: "ignore", detached: false }
  );
  childProc.on("error", (err) => {
    // systemd-inhibit may not exist on all distros — degrade gracefully
    console.warn("[keep-awake] systemd-inhibit not available:", err.message);
    childProc = null;
  });
}

function stopChildProcess(): void {
  if (childProc) {
    childProc.kill();
    childProc = null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function initKeepAwake(): void {
  if (timer || childProc) return; // already active

  const os = platform();

  switch (os) {
    case "win32":
      startWindows();
      break;
    case "darwin":
      startDarwin();
      break;
    case "linux":
      startLinux();
      break;
    default:
      console.warn(`[keep-awake] unsupported platform: ${os}`);
      return;
  }

  console.log(`[keep-awake] active (${os})`);
}

export function shutdownKeepAwake(): void {
  if (!timer && !childProc) return; // nothing to release

  const os = platform();

  if (os === "win32") {
    stopWindows();
  } else {
    stopChildProcess();
  }

  console.log("[keep-awake] released");
}
