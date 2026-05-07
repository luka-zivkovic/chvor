import { mouse, keyboard, Button, Key, Point } from "@nut-tree-fork/nut-js";
import { getScreenSize, TARGET_WIDTH, TARGET_HEIGHT } from "./screen.ts";

function resolveCoordinateSpace(
  screenWidth: number | undefined,
  screenHeight: number | undefined
): { width: number; height: number } {
  const hasWidth = screenWidth !== undefined;
  const hasHeight = screenHeight !== undefined;
  if (!hasWidth && !hasHeight) return { width: TARGET_WIDTH, height: TARGET_HEIGHT };
  if (!hasWidth || !hasHeight) {
    throw new Error(
      "Coordinate actions require both screenWidth and screenHeight when either is provided"
    );
  }
  if (
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    !Number.isInteger(screenWidth) ||
    !Number.isInteger(screenHeight) ||
    screenWidth <= 0 ||
    screenHeight <= 0 ||
    screenWidth > 10000 ||
    screenHeight > 10000
  ) {
    throw new Error(`Invalid coordinate space: ${screenWidth}x${screenHeight}`);
  }
  return { width: screenWidth, height: screenHeight };
}

/** Scale coordinates from the model's screenshot space to native screen resolution. */
async function scaleCoordinate(
  x: number,
  y: number,
  screenWidth?: number,
  screenHeight?: number
): Promise<Point> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid coordinates: (${x}, ${y})`);
  }
  const space = resolveCoordinateSpace(screenWidth, screenHeight);
  const inputMaxX = Math.max(0, space.width - 1);
  const inputMaxY = Math.max(0, space.height - 1);
  const clampedX = Math.max(0, Math.min(inputMaxX, x));
  const clampedY = Math.max(0, Math.min(inputMaxY, y));
  const { width, height } = await getScreenSize();
  const nativeMaxX = Math.max(0, width - 1);
  const nativeMaxY = Math.max(0, height - 1);
  return new Point(
    Math.round((clampedX / Math.max(1, inputMaxX)) * nativeMaxX),
    Math.round((clampedY / Math.max(1, inputMaxY)) * nativeMaxY)
  );
}

/** Map key name strings to nut-js Key enum values */
function parseKey(name: string): number {
  const keyMap: Record<string, number> = {
    enter: Key.Enter,
    return: Key.Enter,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    home: Key.Home,
    end: Key.End,
    pageup: Key.PageUp,
    pagedown: Key.PageDown,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    meta: Key.LeftSuper,
    cmd: Key.LeftSuper,
    win: Key.LeftSuper,
    super: Key.LeftSuper,
    f1: Key.F1,
    f2: Key.F2,
    f3: Key.F3,
    f4: Key.F4,
    f5: Key.F5,
    f6: Key.F6,
    f7: Key.F7,
    f8: Key.F8,
    f9: Key.F9,
    f10: Key.F10,
    f11: Key.F11,
    f12: Key.F12,
  };

  const lower = name.toLowerCase();
  if (keyMap[lower] !== undefined) return keyMap[lower];

  // Single character -> use its key code
  if (name.length === 1) {
    return name.charCodeAt(0);
  }

  throw new Error(`Unknown key: ${name}`);
}

export interface ActionInput {
  action: string;
  coordinate?: [number, number];
  /** Width/height of the screenshot coordinate space used for coordinate. */
  screenWidth?: number;
  screenHeight?: number;
  text?: string;
  keys?: string;
  direction?: string;
  amount?: number;
  duration?: number;
}

export async function executeAction(input: ActionInput): Promise<void> {
  switch (input.action) {
    case "mouse_move": {
      if (!input.coordinate) throw new Error("mouse_move requires coordinate");
      const pt = await scaleCoordinate(
        input.coordinate[0],
        input.coordinate[1],
        input.screenWidth,
        input.screenHeight
      );
      await mouse.setPosition(pt);
      break;
    }

    case "left_click": {
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
      }
      await mouse.click(Button.LEFT);
      break;
    }

    case "right_click": {
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
      }
      await mouse.click(Button.RIGHT);
      break;
    }

    case "double_click": {
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
      }
      await mouse.doubleClick(Button.LEFT);
      break;
    }

    case "middle_click": {
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
      }
      await mouse.click(Button.MIDDLE);
      break;
    }

    case "type": {
      if (!input.text) throw new Error("type requires text");
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
        await mouse.click(Button.LEFT);
      }
      const text = input.text.slice(0, 10_000);
      await keyboard.type(text);
      break;
    }

    case "key": {
      if (!input.keys) throw new Error("key requires keys");
      const parts = input.keys.split("+").map((k) => k.trim());
      const keys = parts.map(parseKey);
      if (keys.length === 1) {
        await keyboard.pressKey(keys[0]);
        await keyboard.releaseKey(keys[0]);
      } else {
        // Press modifiers, then the final key, then release in reverse
        for (const k of keys) await keyboard.pressKey(k);
        for (const k of [...keys].reverse()) await keyboard.releaseKey(k);
      }
      break;
    }

    case "scroll": {
      const amount = Math.max(1, Math.min(20, input.amount ?? 3));
      const dir = input.direction ?? "down";
      if (input.coordinate) {
        const pt = await scaleCoordinate(
          input.coordinate[0],
          input.coordinate[1],
          input.screenWidth,
          input.screenHeight
        );
        await mouse.setPosition(pt);
      }
      if (dir === "left" || dir === "right") {
        // nut-js scrollRight may not exist in all versions — fall back safely
        const hAmount = dir === "left" ? -amount : amount;
        if (typeof mouse.scrollRight === "function") {
          await mouse.scrollRight(hAmount);
        } else {
          throw new Error("Horizontal scroll not supported on this platform");
        }
      } else {
        const vAmount = dir === "up" ? -amount : amount;
        await mouse.scrollDown(vAmount);
      }
      break;
    }

    case "screenshot": {
      // No-op — handled at the caller level
      break;
    }

    case "wait": {
      const ms = Math.min(30_000, input.duration ?? 1000);
      await new Promise((r) => setTimeout(r, ms));
      break;
    }

    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}

/** Resolve an a11y node's bounding box to a click coordinate in model screenshot space. */
export function bboxToCoordinate(
  bbox: [number, number, number, number],
  screenWidth: number,
  screenHeight: number,
  outputWidth = TARGET_WIDTH,
  outputHeight = TARGET_HEIGHT
): [number, number] {
  const [x, y, w, h] = bbox;
  // Center of the bounding box in native coords -> scale to target coords
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const outputMaxX = Math.max(0, outputWidth - 1);
  const outputMaxY = Math.max(0, outputHeight - 1);
  const xCoord = Math.round((centerX / Math.max(1, screenWidth - 1)) * outputMaxX);
  const yCoord = Math.round((centerY / Math.max(1, screenHeight - 1)) * outputMaxY);
  return [Math.max(0, Math.min(outputMaxX, xCoord)), Math.max(0, Math.min(outputMaxY, yCoord))];
}
