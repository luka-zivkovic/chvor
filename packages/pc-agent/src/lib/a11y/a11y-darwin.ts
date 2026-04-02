import { execFile } from "node:child_process";
import type { A11yTree } from "./types.ts";

/**
 * macOS accessibility tree via inline Swift script.
 *
 * Spawns `swift -` with a script piped to stdin that uses the native
 * Accessibility framework (AXUIElement) to walk the focused app's UI tree.
 * Mirrors the Windows approach (PowerShell/.NET UIA).
 *
 * Requirements:
 * - Xcode Command Line Tools (`xcode-select --install`)
 * - Accessibility permission granted in System Settings > Privacy & Security > Accessibility
 */

const SWIFT_SCRIPT = `
import Cocoa
import ApplicationServices

// ---------------------------------------------------------------------------
// Config (injected at runtime)
// ---------------------------------------------------------------------------

let maxDepth = MAX_DEPTH_PLACEHOLDER
let maxNodes = 500

// ---------------------------------------------------------------------------
// Role mapping — AX roles to simplified names matching Windows output
// ---------------------------------------------------------------------------

let roleMap: [String: String] = [
    "AXWindow": "window",
    "AXButton": "button",
    "AXTextField": "textfield",
    "AXTextArea": "textarea",
    "AXStaticText": "text",
    "AXLink": "link",
    "AXImage": "image",
    "AXGroup": "group",
    "AXList": "list",
    "AXTable": "table",
    "AXRow": "row",
    "AXCell": "cell",
    "AXColumn": "column",
    "AXCheckBox": "checkbox",
    "AXRadioButton": "radiobutton",
    "AXPopUpButton": "popupbutton",
    "AXMenuButton": "menubutton",
    "AXMenu": "menu",
    "AXMenuItem": "menuitem",
    "AXMenuBar": "menubar",
    "AXMenuBarItem": "menubaritem",
    "AXToolbar": "toolbar",
    "AXTabGroup": "tabgroup",
    "AXTab": "tab",
    "AXScrollArea": "scrollarea",
    "AXSlider": "slider",
    "AXComboBox": "combobox",
    "AXHeading": "heading",
    "AXWebArea": "webarea",
    "AXSheet": "sheet",
    "AXDialog": "dialog",
    "AXSplitGroup": "splitgroup",
    "AXOutline": "outline",
    "AXDisclosureTriangle": "disclosuretriangle",
    "AXProgressIndicator": "progressbar",
    "AXBrowser": "browser",
    "AXValueIndicator": "valueindicator",
    "AXScrollBar": "scrollbar",
    "AXIncrementor": "incrementor",
    "AXColorWell": "colorwell",
    "AXSplitter": "splitter",
    "AXRelevanceIndicator": "relevanceindicator",
    "AXApplication": "application",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func getAttr(_ element: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard err == .success else { return nil }
    return value
}

func getBBox(_ element: AXUIElement) -> [Int]? {
    guard let posValue = getAttr(element, kAXPositionAttribute as String),
          let sizeValue = getAttr(element, kAXSizeAttribute as String) else {
        return nil
    }
    // AXPosition and AXSize are AXValueRef wrapping CGPoint / CGSize
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
        return nil
    }
    // Skip zero-area elements
    if size.width <= 0 || size.height <= 0 { return nil }
    return [Int(point.x), Int(point.y), Int(size.width), Int(size.height)]
}

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

var counter = 0

func walkElement(_ element: AXUIElement, depth: Int) -> [String: Any]? {
    if depth > maxDepth || counter >= maxNodes { return nil }
    counter += 1

    // Role
    let rawRole = (getAttr(element, kAXRoleAttribute as String) as? String) ?? "unknown"
    let role = roleMap[rawRole] ?? rawRole
        .replacingOccurrences(of: "AX", with: "")
        .lowercased()

    // Name: prefer title, fall back to description
    let title = getAttr(element, kAXTitleAttribute as String) as? String
    let desc = getAttr(element, kAXDescriptionAttribute as String) as? String
    let name = title ?? desc ?? ""

    // Value (for text fields, sliders, etc.)
    let rawValue = getAttr(element, kAXValueAttribute as String)
    var valueStr: String? = nil
    if let s = rawValue as? String, !s.isEmpty {
        valueStr = s
    } else if let n = rawValue as? NSNumber {
        // For checkboxes/radios, capture as state instead
        if rawRole == "AXCheckBox" || rawRole == "AXRadioButton" {
            valueStr = nil // handled in states
        } else {
            valueStr = n.stringValue
        }
    }

    // Bounding box
    let bbox = getBBox(element)

    // States
    var states: [String] = []
    if let enabled = getAttr(element, kAXEnabledAttribute as String) as? Bool, !enabled {
        states.append("disabled")
    }
    if let focused = getAttr(element, kAXFocusedAttribute as String) as? Bool, focused {
        states.append("focused")
    }
    if let expanded = getAttr(element, kAXExpandedAttribute as String) as? Bool, expanded {
        states.append("expanded")
    }
    if let selected = getAttr(element, kAXSelectedAttribute as String) as? Bool, selected {
        states.append("selected")
    }
    // Checked state for checkboxes / radio buttons
    if rawRole == "AXCheckBox" || rawRole == "AXRadioButton" {
        if let n = rawValue as? NSNumber, n.intValue == 1 {
            states.append("checked")
        }
    }

    // Children
    var childNodes: [[String: Any]] = []
    if let children = getAttr(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children {
            if counter >= maxNodes { break }
            if let childNode = walkElement(child, depth: depth + 1) {
                childNodes.append(childNode)
            }
        }
    }

    // Build node dict
    var node: [String: Any] = [
        "id": counter,
        "role": role,
        "name": name,
    ]
    if let v = valueStr { node["value"] = v }
    if let b = bbox { node["bbox"] = b }
    if !states.isEmpty { node["states"] = states }
    if !childNodes.isEmpty { node["children"] = childNodes }

    return node
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Check accessibility trust (don't prompt — let the caller handle that)
let opts = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): false] as CFDictionary
guard AXIsProcessTrustedWithOptions(opts) else {
    let err: [String: Any] = ["error": "accessibility_not_trusted"]
    let data = try! JSONSerialization.data(withJSONObject: err)
    FileHandle.standardOutput.write(data)
    exit(1)
}

// Get frontmost application
guard let frontApp = NSWorkspace.shared.frontmostApplication else {
    let err: [String: Any] = ["error": "no_frontmost_app"]
    let data = try! JSONSerialization.data(withJSONObject: err)
    FileHandle.standardOutput.write(data)
    exit(1)
}

let pid = frontApp.processIdentifier
let appElement = AXUIElementCreateApplication(pid)

// Walk the tree
guard let root = walkElement(appElement, depth: 0) else {
    let err: [String: Any] = ["error": "empty_tree"]
    let data = try! JSONSerialization.data(withJSONObject: err)
    FileHandle.standardOutput.write(data)
    exit(1)
}

let tree: [String: Any] = [
    "platform": "darwin",
    "timestamp": ISO8601DateFormatter().string(from: Date()),
    "root": root,
    "nodeCount": counter,
]

let jsonData = try! JSONSerialization.data(withJSONObject: tree)
FileHandle.standardOutput.write(jsonData)
`;

export async function queryA11yTreeDarwin(opts?: { maxDepth?: number }): Promise<A11yTree | null> {
  const maxDepth = Math.min(Math.max(opts?.maxDepth ?? 6, 1), 20);
  const script = SWIFT_SCRIPT.replace("MAX_DEPTH_PLACEHOLDER", String(maxDepth));

  return new Promise((resolve) => {
    const proc = execFile(
      "swift",
      ["-"],
      {
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          // Check if we got a structured error on stdout before the exit
          if (stdout) {
            try {
              const errObj = JSON.parse(stdout.trim());
              if (errObj.error === "accessibility_not_trusted") {
                console.warn(
                  "[a11y-darwin] Accessibility permission not granted. " +
                    "Enable in System Settings > Privacy & Security > Accessibility"
                );
              } else if (errObj.error) {
                console.warn(`[a11y-darwin] ${errObj.error}`);
              }
            } catch {
              // not JSON, fall through
            }
          }
          if (!stdout?.includes("accessibility_not_trusted")) {
            console.warn("[a11y-darwin] Swift error:", stderr || err.message);
          }
          resolve(null);
          return;
        }

        try {
          const raw = JSON.parse(stdout.trim());
          if (raw.error) {
            console.warn(`[a11y-darwin] ${raw.error}`);
            resolve(null);
            return;
          }
          resolve(raw as A11yTree);
        } catch (parseErr) {
          console.warn("[a11y-darwin] JSON parse error:", (parseErr as Error).message);
          resolve(null);
        }
      }
    );

    // Pipe the Swift script to stdin
    proc.stdin?.write(script);
    proc.stdin?.end();
  });
}
