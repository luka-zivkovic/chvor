# Pretext — spike: where else can we use it?

This is a research note, not an implementation. We want to figure out how
much more mileage we can get out of `@chenglou/pretext` (v0.0.4) on the
frontend, starting from the fact that it's currently used in exactly one
place.

---

## 1. What pretext is actually good at

- **Variable-width per-line layout.** `layoutNextLine(prepared, cursor, maxWidth)`
  lays out the next line fitting `maxWidth`. You can change `maxWidth` between
  calls, so text flows around obstacles whose shape varies with `y`.
- **Grapheme- and kerning-aware measurement.** `prepareWithSegments(text, font)`
  precomputes grapheme boundaries and advance widths off of canvas
  `measureText`, and caches the result.
- **Resumable cursor.** `LayoutCursor` lets you stop and continue. That turns
  line-breaking into a streaming primitive — you can animate the cursor
  forward one grapheme per frame for a typewriter effect, or pause on an
  incomplete segment and resume when more text arrives.
- **Canvas-native.** It was built against `CanvasRenderingContext2D`, which
  is how our thought stream renders.

## 2. What pretext is NOT good at

- **Per-glyph layout on an arbitrary path.** Pretext lays out lines, not
  glyphs-on-a-curve. If you want text to follow a bezier or wrap around a
  circle, pretext will not help you place each character at its own angle.
- **SVG text.** SVG has `<textPath>` natively. Pretext adds nothing here.
- **DOM measurement.** The browser already measures DOM text. Running
  pretext over DOM strings would duplicate work (and the font metrics
  wouldn't even match exactly — pretext reads from a canvas context, DOM
  layout comes from the browser's own shaper).

The rule of thumb: if the text lives on a `<canvas>`, pretext is a
candidate. Otherwise, it usually isn't.

## 3. Where pretext is used today

One file: `apps/client/src/lib/thought-stream/text-layout.ts`.

- Imports `prepareWithSegments`, `layoutNextLine`, `clearCache`,
  `PreparedTextWithSegments`, `LayoutCursor`, `LayoutLine`
  (`text-layout.ts:8-9`).
- `getPrepared()` (`text-layout.ts:40-58`) keeps an LRU of prepared text
  keyed by `${font}|${text}`, max 100 entries.
- `layoutThoughtStream()` (`text-layout.ts:66-113`) walks the thought
  segments. For each visible segment it asks `buildLineWidthFn` from
  `exclusion-zones.ts:72-136` for the available slot at each `y`, then
  calls `layoutNextLine` once per line. Variable width is how the text
  flows around orbital nodes.
- The rendering side is `ThoughtStreamCanvas.tsx`:
  `layoutThoughtStream` at line 82, `ctx.fillText` at line 107, inside a
  rAF loop that only runs while `isActive || segments.length > 0`.
- Execution finish schedules a cache clear 10s later
  (`use-thought-stream.ts:142-149`).

So today we use the **variable-width line layout** cleanly, and the
**prepared-text cache**. We don't use the **resumable cursor** for
anything streaming-y, and there's only one canvas consumer.

## 4. Direction A — Edge labels on active ReactFlow edges

### What we'd draw

Short status labels on edges while they're active:

- `invoking · fetch_weather`
- `returned · 12 rows`
- `failed · timeout`

Only for edges where `edge.data.active === true`. Ghost edges stay silent.

### Approaches considered

**SVG `<textPath>`.** Native, supported by ReactFlow, works along any path.
But it's a browser feature; it doesn't exercise pretext at all. Worth
mentioning for completeness, but it's orthogonal to this spike.

**Canvas midpoint labels with pretext streaming.** This is the one worth
prototyping. It piggybacks on the canvas layer we already run.

### Approach (recommended)

Draw on the existing `ThoughtStreamCanvas`. It already has the rAF loop,
HiDPI sizing, and emotion-tinted styling; adding a second pass over the
active edges is cheap. For each active edge:

1. Compute midpoint and tangent. `AnimatedEdge.tsx:21-34` already uses
   `getFloatingEdgeParams` + `getBezierPath` for the stroke; we reuse the
   same inputs and evaluate the bezier at `t = 0.5` for position and its
   derivative for the tangent angle.
2. Reuse the shared LRU via `getPrepared(label, font)`.
3. Lay out one line: `layoutNextLine(prepared, cursor, chord * 0.7)` so
   the label sits inside the chord with some margin. Never wrap — edge
   labels are one line by construction.
4. Animate the cursor grapheme-by-grapheme while the edge is active
   (typewriter-in), hold on the final cursor when the edge stays active
   on a terminal state, fade out over ~500ms when `active` flips false.
5. Draw rotated:

   ```ts
   ctx.save();
   ctx.translate(mx, my);
   ctx.rotate(tangent);
   ctx.fillText(line.text, -line.width / 2, 0);
   ctx.restore();
   ```

### Sketch

New file: `apps/client/src/lib/thought-stream/edge-labels.ts`.

```ts
import { prepareWithSegments, layoutNextLine } from "@chenglou/pretext";
import type { LayoutCursor } from "@chenglou/pretext";

export interface EdgeLabelInput {
  id: string;
  label: string;
  font: string;
  // Bezier control points (screen-space, post viewport transform)
  sx: number; sy: number; tx: number; ty: number;
  curvature: number;
  // 0..1 streaming progress derived from time-since-activation
  progress: number;
}

export interface RenderedEdgeLabel {
  text: string;
  x: number; y: number;   // midpoint, screen-space
  angle: number;          // tangent at midpoint, radians
  width: number;          // for centering around (x, y)
  font: string;
}

export function layoutEdgeLabel(input: EdgeLabelInput): RenderedEdgeLabel | null {
  const { mx, my, angle, chord } = bezierMidpoint(input);
  const prepared = getPrepared(input.label, input.font); // shared LRU from text-layout.ts
  const cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };
  const line = layoutNextLine(prepared, cursor, chord * 0.7);
  if (!line) return null;
  const visibleGraphemes = Math.ceil(countGraphemes(line.text) * input.progress);
  return {
    text: sliceGraphemes(line.text, visibleGraphemes),
    x: mx, y: my, angle,
    width: line.width,
    font: input.font,
  };
}
```

Wiring in `ThoughtStreamCanvas.tsx`: after the existing thought-line loop
(around line 108), iterate `useCanvasStore((s) => s.edges).filter(e => e.data?.active)`,
build an `EdgeLabelInput` per edge, call `layoutEdgeLabel`, and draw each
with the `save/translate/rotate/fillText/restore` pattern above. Font
should match the existing monospace used for skill/tool thoughts
(`fontForType` in `use-thought-stream.ts:57-59`).

Label source: we already have the text. `use-thought-stream.ts:34-45`
turns `skill.invoked` / `tool.invoked` etc. into human-readable strings.
The cleanest wiring is to mirror that mapping into a tiny edge-label
store (or reuse `ChvorEdge.data` with a new `label?: string` field) that
`setEdgeActive` writes to when it flips the edge on.

### Gains

- Exercises pretext's **cursor + measurement** surface, which the current
  thought-stream usage doesn't touch.
- Reuses the LRU cache, the rAF loop, the DPR handling, and the emotion
  tint — almost all the code already exists.
- One-line by construction, so we sidestep the arc-wrap problem.

### Risks

- Labels longer than `0.7 * chord` truncate. That's consistent with how
  thoughts behave when their slot is narrow; we should accept it.
- Per-frame cost scales with the number of active edges. In practice that's
  1–3 during execution, so it's fine, but the implementation should skip
  the whole pass when no edges are active.
- We need a lifecycle story: when does a label fade? The simplest answer
  is "while `edge.data.active`, plus a 500ms fade after it flips off,"
  which matches the existing thought-segment fade.

## 5. Direction B — Hub status text around orbits

### What we'd draw

An aggregated status line near each hub while its satellites are doing
something. Examples:

- `3 skills running · 1 failed` below `SkillsHub`
- `2 tools queued` below `ToolsHub`
- `consolidating memory…` below whatever hub owns memory in the moment

Source: count each hub's satellites grouped by `executionStatus` (from
`canvas-store.ts` — every satellite node carries
`executionStatus: "idle" | "pending" | "running" | "completed" | "failed" | "waiting"`).

### Why not true arc text?

A hub with its label wrapped around the orbit would look great, but
pretext is line-oriented. To do per-glyph arc placement we'd only use
pretext as a font-advance cache, and a hand-written loop over
`measureText` would do that equally well. If you see "arc text with
pretext" on a roadmap, push back — that's using a power tool as a
paperweight. If we really want arc text later, that's a different
library choice (or a small custom module), not a pretext expansion.

### Approach (recommended)

Banner-style status, using the same variable-width exclusion trick we
already use for thoughts. Treat the hub and the satellites immediately
around it as exclusion rects inside a shallow band (2 lines tall)
anchored just below the hub. Lay out one or two status lines via
`layoutNextLine`, flowing around whichever satellites poke into the band.

Renders on the same `ThoughtStreamCanvas`. Slightly larger font, lower
opacity than thoughts, so it reads as chrome rather than content.

### Sketch

New helpers, either appended to `text-layout.ts` or split into a sibling
`hub-labels.ts`:

```ts
// apps/client/src/lib/thought-stream/hub-labels.ts
import type { LineSlot } from "./exclusion-zones";
import type { RenderedLine } from "./text-layout";

export interface HubStatusInput {
  hubRect: Rect;          // hub node bounds in screen-space
  satelliteRects: Rect[]; // neighbor-node bounds in screen-space
  text: string;           // "3 skills running · 1 failed"
  font: string;
  bandHeight: number;     // e.g. 2 * LINE_HEIGHT
}

export function layoutHubStatus(input: HubStatusInput): RenderedLine[] {
  const bandY = input.hubRect.bottom + 8;
  const getLineWidth = bandLineWidthFn(
    input.hubRect,
    input.satelliteRects,
    bandY,
    input.bandHeight,
  );
  // Reuse getPrepared + layoutNextLine loop from text-layout.ts,
  // capped at 2 lines so status never balloons.
  return layoutLinesInBand(input.text, input.font, getLineWidth, bandY, 2);
}
```

`bandLineWidthFn` is a small variant of `buildLineWidthFn` scoped to a
band rather than the full canvas. Same `LineSlot { startX, maxWidth }`
contract, so `layoutNextLine` consumes it unchanged.

For the per-hub derivation, something like:

```ts
function skillsHubStatus(nodes: ChvorNode[]): string | null {
  let running = 0, failed = 0;
  for (const n of nodes) {
    if (n.type !== "skill") continue;
    if (n.data.executionStatus === "running") running++;
    else if (n.data.executionStatus === "failed") failed++;
  }
  if (running === 0 && failed === 0) return null;
  const parts: string[] = [];
  if (running) parts.push(`${running} skill${running === 1 ? "" : "s"} running`);
  if (failed)  parts.push(`${failed} failed`);
  return parts.join(" · ");
}
```

Return `null` → banner hides. That keeps the canvas quiet when nothing
is happening.

Streaming is optional for direction B — we can reuse the cursor
grapheme-per-frame trick from direction A if we want "…consolidating
memory" to appear to be typed. But for straight counts, a static render
that updates whenever the count changes is probably nicer.

### Gains

- Reuses `layoutNextLine` plus a per-line width function: pretext's core
  capability doing the core work.
- No new canvas layer, no arc math, no new font pipeline.
- Status text flows around satellites automatically as they orbit.

### Risks

- Loses the "arc text" aesthetic if that was the picture in someone's
  head. Acknowledge up front and move on.
- Banner band and the existing thought band could collide visually.
  Thoughts anchor near the brain (centre of canvas); hub banners would
  anchor below each hub. These sit in different `y` ranges in practice,
  but this is an assumption to sanity-check on real viewports before
  rolling out.

## 6. Cross-cutting refactors this would want

If both directions ship, a small amount of shared plumbing earns its
keep. These are refactor preconditions, not the spike itself:

- Promote `getPrepared` to an exported module-scope helper from
  `text-layout.ts` so `edge-labels.ts` and `hub-labels.ts` share one LRU.
- `Rect` and `LineSlot` are already in `exclusion-zones.ts`; keep them
  there and let the new modules import.
- Extract a generalised `linesInBand(prepared, getLineWidth, startY, maxLines)`
  out of the inner loop of `layoutThoughtStream` so it's reusable.
- Expand `clearLayoutCache` in `text-layout.ts:116-119` to also clear any
  new per-module caches we introduce; keep the 10s post-execution clear
  in `use-thought-stream.ts:142-149` as the single entry point.

## 7. Files a future implementation would touch

- `apps/client/src/lib/thought-stream/text-layout.ts` — existing pretext
  usage; `getPrepared`, `layoutThoughtStream`, `clearLayoutCache`.
- `apps/client/src/lib/thought-stream/exclusion-zones.ts` — `LineSlot`,
  `buildLineWidthFn`, `Rect`; band variant would live next to these.
- `apps/client/src/components/canvas/ThoughtStreamCanvas.tsx` — rAF loop,
  HiDPI, emotion tint; the place to call new layout functions and draw.
- `apps/client/src/components/canvas/AnimatedEdge.tsx` — bezier math for
  edge midpoints lives at lines 21-34; reused, not modified.
- `apps/client/src/components/canvas/SkillsHubNode.tsx` (and the seven
  other `*HubNode.tsx` files) — hub positions and existing label format.
- `apps/client/src/stores/canvas-store.ts` — `ChvorNode`, `ChvorEdge`,
  `executionStatus`; source of truth for both directions.
- `apps/client/src/hooks/use-thought-stream.ts` — existing event-to-text
  mapping at lines 34-45; tap here for edge labels.

## 8. Limits of this spike

- Arc text is out.
- DOM text is out.
- Both directions assume the `ThoughtStreamCanvas` remains the sole
  canvas layer. If a second canvas ever appears, we'd want to route
  through a shared "canvas layout service" instead of piling more passes
  onto this one file.
- Pretext's version (0.0.4) suggests upstream API churn is possible.
  Nothing above depends on unreleased features, but any implementation
  should pin the version and re-read the exports when upgrading.
