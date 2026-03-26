import { execFile } from "node:child_process";
import type { A11yTree } from "./types.ts";

/**
 * Windows accessibility tree via PowerShell/.NET System.Windows.Automation.
 *
 * Spawns a persistent PowerShell process that walks the UIA tree for the
 * foreground window and returns JSON. The .NET UIA API is fully featured
 * and avoids native addon compilation.
 */

const PS_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-ForegroundWindow {
  Add-Type -TypeDefinition @'
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
      [DllImport("user32.dll")]
      public static extern IntPtr GetForegroundWindow();
    }
'@
  return [Win32]::GetForegroundWindow()
}

function Walk-Element {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [int]$Depth,
    [int]$MaxDepth,
    [ref]$Counter
  )

  if ($Depth -gt $MaxDepth -or $Counter.Value -gt 500) { return $null }

  $Counter.Value++
  $current = $Element.Current

  $states = @()
  try {
    if ($current.IsEnabled -eq $false) { $states += "disabled" }
    if ($current.IsKeyboardFocusable) {
      if ($current.HasKeyboardFocus) { $states += "focused" }
    }
  } catch {}

  $bbox = $null
  try {
    $rect = $current.BoundingRectangle
    if (-not [System.Windows.Rect]::Empty.Equals($rect)) {
      $bbox = @([int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
    }
  } catch {}

  $value = $null
  try {
    $vp = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { $value = $vp.Current.Value }
  } catch {}

  $children = @()
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $child = $walker.GetFirstChild($Element)
  while ($child -ne $null -and $Counter.Value -le 500) {
    $childNode = Walk-Element -Element $child -Depth ($Depth + 1) -MaxDepth $MaxDepth -Counter $Counter
    if ($childNode) { $children += $childNode }
    $child = $walker.GetNextSibling($child)
  }

  return @{
    id = $Counter.Value
    role = $current.ControlType.ProgrammaticName -replace 'ControlType\\.', ''
    name = $current.Name
    value = $value
    bbox = $bbox
    states = $states
    children = $children
  }
}

$maxDepth = MAX_DEPTH_PLACEHOLDER
$hwnd = Get-ForegroundWindow
$ae = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

$counter = [ref]0
$tree = Walk-Element -Element $ae -Depth 0 -MaxDepth $maxDepth -Counter $counter

@{
  platform = "win32"
  timestamp = (Get-Date -Format o)
  root = $tree
  nodeCount = $counter.Value
} | ConvertTo-Json -Depth 20 -Compress
`;

export async function queryA11yTreeWin32(opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  const maxDepth = Math.min(Math.max(opts?.maxDepth ?? 6, 1), 20);
  const script = PS_SCRIPT.replace("MAX_DEPTH_PLACEHOLDER", String(maxDepth));

  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        console.warn("[a11y-win32] PowerShell error:", stderr || err.message);
        resolve(null);
        return;
      }
      try {
        const raw = JSON.parse(stdout.trim());
        resolve(raw as A11yTree);
      } catch (parseErr) {
        console.warn("[a11y-win32] JSON parse error:", (parseErr as Error).message);
        resolve(null);
      }
    });
  });
}
