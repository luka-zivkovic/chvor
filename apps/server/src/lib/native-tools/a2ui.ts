import { tool } from "ai";
import { z } from "zod";
import type { GatewayServerEvent, A2UIComponentEntry } from "@chvor/shared";
import { sanitizeA2UIAction } from "@chvor/shared";
import {
  upsertSurface,
  updateBindings as updateSurfaceBindings,
  deleteSurface as deleteSurfaceFromDb,
  deleteAllSurfaces,
} from "../../db/a2ui-store.ts";
import { isCapabilityEnabled } from "../../db/config-store.ts";
import type { NativeToolContext, NativeToolHandler, NativeToolModule, NativeToolResult } from "./types.ts";

// ---------------------------------------------------------------------------
// A2UI — Agent-to-User Interface protocol
// ---------------------------------------------------------------------------

const A2UI_PUSH_NAME = "native__canvas_a2ui_push";

const a2uiPushToolDef = tool({
  description:
    "[A2UI Push] Build a visual UI on the Brain Canvas. Use this when the user asks to build a dashboard, chart, table, form, or any visual interface. Send surfaceUpdate to define components, beginRendering to display them, and dataModelUpdate to update bound data. Components: Text, Column, Row, Image, Table, Button, Form, Input, Chart. Always send all three message types in a single call.",
  parameters: z.object({
    messages: z
      .array(
        z.union([
          z.object({
            surfaceUpdate: z.object({
              surfaceId: z.string().describe("Unique surface identifier"),
              title: z.string().optional().describe("Human-readable title for the surface"),
              components: z.array(
                z.object({
                  id: z.string().describe("Unique component id"),
                  component: z.record(z.unknown()).describe("Component definition object (e.g. {Text:{text:{literalString:'Hello'},usageHint:'h1'}})"),
                })
              ),
            }),
          }),
          z.object({
            beginRendering: z.object({
              surfaceId: z.string(),
              root: z.string().describe("Component id to use as the root of the render tree"),
            }),
          }),
          z.object({
            dataModelUpdate: z.object({
              surfaceId: z.string(),
              bindings: z.record(z.unknown()).describe("Key-value data bindings to update"),
            }),
          }),
        ])
      )
      .describe("Array of A2UI protocol messages to process"),
  }),
});

const handleA2UIPush: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
  const ws = getWSInstance();
  const sessionId = context?.sessionId;

  if (!ws) {
    return { content: [{ type: "text", text: "A2UI: no active WebSocket connection. Surface not delivered." }] };
  }

  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { content: [{ type: "text", text: "No A2UI messages provided." }] };
  }

  const send = (event: GatewayServerEvent) => {
    if (sessionId) ws.broadcastToSession(sessionId, event);
    else ws.broadcast(event);
  };

  // ── Phase 1: Collect all data per surface before emitting events ──
  const surfaceData = new Map<string, {
    components: A2UIComponentEntry[];
    componentMap: Record<string, A2UIComponentEntry>;
    root: string | null;
    bindings: Record<string, unknown> | null;
    title: string | null;
  }>();

  const surfaceIds = new Set<string>();

  const getOrCreate = (sid: string) => {
    let entry = surfaceData.get(sid);
    if (!entry) {
      entry = { components: [], componentMap: {}, root: null, bindings: null, title: null };
      surfaceData.set(sid, entry);
    }
    return entry;
  };

  for (const msg of messages) {
    if (typeof msg !== "object" || msg == null) continue;
    const m = msg as Record<string, unknown>;

    if ("surfaceUpdate" in m && typeof m.surfaceUpdate === "object" && m.surfaceUpdate != null) {
      const su = m.surfaceUpdate as { surfaceId: string; title?: string; components: Array<{ id: string; component: Record<string, unknown> }> };
      if (typeof su.surfaceId !== "string") continue;

      surfaceIds.add(su.surfaceId);

      const entry = getOrCreate(su.surfaceId);
      if (typeof su.title === "string" && su.title.trim()) {
        entry.title = su.title.trim();
      }
      if (Array.isArray(su.components)) {
        for (const c of su.components) {
          entry.componentMap[c.id] = c as unknown as A2UIComponentEntry;
          entry.components.push(c as unknown as A2UIComponentEntry);
        }
      }
    } else if ("beginRendering" in m && typeof m.beginRendering === "object" && m.beginRendering != null) {
      const br = m.beginRendering as { surfaceId: string; root: string };
      if (typeof br.surfaceId !== "string" || typeof br.root !== "string") continue;
      surfaceIds.add(br.surfaceId);
      getOrCreate(br.surfaceId).root = br.root;
    } else if ("dataModelUpdate" in m && typeof m.dataModelUpdate === "object" && m.dataModelUpdate != null) {
      const dm = m.dataModelUpdate as { surfaceId: string; bindings: Record<string, unknown> };
      if (typeof dm.surfaceId !== "string") continue;
      surfaceIds.add(dm.surfaceId);
      getOrCreate(dm.surfaceId).bindings = dm.bindings ?? {};
    }
  }

  // ── Phase 1.5: Validate & normalize component structures ──
  const KNOWN_TYPES = new Set(["Text", "Column", "Row", "Image", "Table", "Button", "Form", "Input", "Chart"]);

  for (const [sid, entry] of surfaceData) {
    for (const [cid, ce] of Object.entries(entry.componentMap)) {
      const comp = ce.component as unknown as Record<string, unknown> | undefined;
      if (!comp || typeof comp !== "object") {
        console.warn(`[a2ui] Surface "${sid}": component "${cid}" has no definition, removing`);
        delete entry.componentMap[cid];
        continue;
      }

      // Check if the component has a recognized type key
      const typeKey = Object.keys(comp).find((k) => KNOWN_TYPES.has(k));
      if (!typeKey) {
        console.warn(`[a2ui] Surface "${sid}": component "${cid}" has unrecognized keys [${Object.keys(comp).join(", ")}]. Raw:`, JSON.stringify(comp));
        // Attempt to infer: if it has "children", it's likely a Column/Row missing the wrapper
        const raw = comp as Record<string, unknown>;
        if (raw.children || raw.items) {
          const childList = raw.children ?? raw.items;
          const normalizedChildren = Array.isArray(childList)
            ? { explicitList: childList as string[] }
            : childList;
          // Capture gap before clearing — raw and comp are the same object reference
          const gap = raw.gap ?? 8;
          // Clear all existing keys and replace with a proper Column wrapper
          for (const k of Object.keys(comp)) delete comp[k];
          comp["Column"] = { children: normalizedChildren, gap };
          console.warn(`[a2ui] Surface "${sid}": auto-wrapped component "${cid}" as Column`);
        }
        // Children already normalized during wrapping; skip further normalization
        continue;
      }

      // Normalize children format: if children is a plain array instead of {explicitList: [...]}
      const inner = comp[typeKey] as Record<string, unknown> | undefined;
      if (inner && (typeKey === "Column" || typeKey === "Row" || typeKey === "Form")) {
        if (Array.isArray(inner.children)) {
          inner.children = { explicitList: inner.children as string[] };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children array → explicitList`);
        } else if (inner.children && typeof inner.children === "object" && !("explicitList" in (inner.children as Record<string, unknown>))) {
          // children object but missing explicitList — check for common alternatives
          const childObj = inner.children as Record<string, unknown>;
          if (Array.isArray(childObj.list)) {
            inner.children = { explicitList: childObj.list as string[] };
            console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children.list → explicitList`);
          } else if (Array.isArray(childObj.items)) {
            inner.children = { explicitList: childObj.items as string[] };
            console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" children.items → explicitList`);
          }
        }
      }

      // Normalize text values: if text is a plain string instead of {literalString: "..."}
      if (typeKey === "Text" && inner) {
        if (typeof inner.text === "string") {
          inner.text = { literalString: inner.text as string };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" text string → literalString`);
        }
      }

      // Normalize Chart data: if data is a plain array instead of a binding/literal
      if (typeKey === "Chart" && inner) {
        if (Array.isArray(inner.data)) {
          // Inline data array — store as binding and convert to bound value
          const bindingKey = `__chart_${cid}`;
          if (!entry.bindings) entry.bindings = {};
          entry.bindings[bindingKey] = inner.data;
          inner.data = { binding: bindingKey };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" inline chart data → binding "${bindingKey}"`);
        }
      }

      // Normalize Table rows: if rows is an array instead of a binding
      if (typeKey === "Table" && inner) {
        if (Array.isArray(inner.rows)) {
          const bindingKey = `__table_${cid}`;
          if (!entry.bindings) entry.bindings = {};
          entry.bindings[bindingKey] = inner.rows;
          inner.rows = { binding: bindingKey };
          console.warn(`[a2ui] Surface "${sid}": normalized "${cid}" inline table rows → binding "${bindingKey}"`);
        }
      }

      // Normalize Button/Image label/src: plain string → literalString
      if (typeKey === "Button" && inner && typeof inner.label === "string") {
        inner.label = { literalString: inner.label as string };
      }
      if (typeKey === "Image" && inner && typeof inner.src === "string") {
        inner.src = { literalString: inner.src as string };
      }

      // A2UI action sandbox — Button.action and Form.submitAction are arbitrary
      // strings on the wire. Strip anything that doesn't match the allowlisted
      // grammar (navigate:<panelId> | emit:<eventName>[?json] | noop) so a
      // malicious surface can't ship raw URLs or javascript:.
      if (typeKey === "Button" && inner && "action" in inner) {
        const before = inner.action;
        inner.action = sanitizeA2UIAction(before);
        if (inner.action === "noop" && before !== "noop") {
          console.warn(
            `[a2ui] Surface "${sid}": dropped unsafe Button action on "${cid}":`,
            before,
          );
        }
      }
      if (typeKey === "Form" && inner && "submitAction" in inner) {
        const before = inner.submitAction;
        inner.submitAction = sanitizeA2UIAction(before);
        if (inner.submitAction === "noop" && before !== "noop") {
          console.warn(
            `[a2ui] Surface "${sid}": dropped unsafe Form submitAction on "${cid}":`,
            before,
          );
        }
      }
    }

    // Rebuild components array from the (now normalized) componentMap
    entry.components = Object.values(entry.componentMap);
  }

  // ── Phase 2: Auto-infer root if LLM omitted beginRendering ──
  for (const [sid, entry] of surfaceData) {
    if (!entry.root && Object.keys(entry.componentMap).length > 0) {
      // Try to find a layout component (Column/Row) as root, otherwise use first component
      const layoutRoot = Object.entries(entry.componentMap).find(
        ([, c]) => c.component && ("Column" in c.component || "Row" in c.component)
      );
      entry.root = layoutRoot ? layoutRoot[0] : Object.keys(entry.componentMap)[0];
      console.warn(`[a2ui] Surface "${sid}": beginRendering missing, auto-inferred root="${entry.root}"`);
    }
  }

  // ── Phase 3: Persist to DB and emit consolidated events ──
  const newSurfaceIds = new Set<string>();

  for (const [sid, entry] of surfaceData) {
    const hasComponents = Object.keys(entry.componentMap).length > 0;

    // Always upsert so the row exists before binding updates.
    // upsertSurface returns true if it inserted a new row (atomic newness check).
    const isNew = upsertSurface({
      surfaceId: sid,
      ...(entry.title ? { title: entry.title } : {}),
      ...(hasComponents ? { components: entry.componentMap } : {}),
      ...(entry.root ? { root: entry.root, rendering: true } : {}),
    });

    if (isNew) newSurfaceIds.add(sid);

    // Send one consolidated surface event with both components AND root
    if (hasComponents || entry.root) {
      send({
        type: "a2ui.surface" as const,
        data: {
          surfaceId: sid,
          components: entry.components,
          ...(entry.root ? { root: entry.root } : {}),
        },
      });
    }

    // Send data bindings (row is guaranteed to exist now)
    if (entry.bindings) {
      updateSurfaceBindings(sid, entry.bindings);
      send({
        type: "a2ui.data" as const,
        data: { surfaceId: sid, bindings: entry.bindings },
      });
    }
  }

  // Send toast only for newly created surfaces
  for (const sid of newSurfaceIds) {
    send({ type: "a2ui.toast" as const, data: { surfaceId: sid, title: "Surface ready" } });
  }

  const ids = [...surfaceIds].join(", ");
  return {
    content: [{ type: "text", text: `A2UI surface(s) updated: ${ids}. ${messages.length} message(s) processed.` }],
  };
};

const A2UI_RESET_NAME = "native__canvas_a2ui_reset";

const a2uiResetToolDef = tool({
  description:
    "[A2UI Reset] Clear the Brain Canvas UI. Use when the user asks to clear, remove, or reset the dashboard/UI. If surfaceId is provided, only that surface is removed. If omitted, all surfaces are cleared.",
  parameters: z.object({
    surfaceId: z
      .string()
      .optional()
      .describe("Surface id to reset. If omitted, all surfaces are cleared."),
  }),
});

const handleA2UIReset: NativeToolHandler = async (
  args: Record<string, unknown>,
  context?: NativeToolContext
): Promise<NativeToolResult> => {
  const { getWSInstance } = await import("../../gateway/ws-instance.ts");
  const ws = getWSInstance();
  const sessionId = context?.sessionId;

  if (!ws) {
    return { content: [{ type: "text", text: "A2UI: no active WebSocket connection. Reset not delivered." }] };
  }

  const surfaceId = args.surfaceId ? String(args.surfaceId) : undefined;

  const send = (event: GatewayServerEvent) => {
    if (sessionId) ws.broadcastToSession(sessionId, event);
    else ws.broadcast(event);
  };

  if (surfaceId) {
    const existed = deleteSurfaceFromDb(surfaceId);
    if (!existed) {
      return { content: [{ type: "text", text: `A2UI surface "${surfaceId}" not found.` }] };
    }
    send({ type: "a2ui.delete" as const, data: { surfaceId } });
    return { content: [{ type: "text", text: `A2UI surface "${surfaceId}" cleared.` }] };
  } else {
    deleteAllSurfaces();
    send({ type: "a2ui.deleteAll" as const, data: {} });
    return { content: [{ type: "text", text: "All A2UI surfaces cleared." }] };
  }
};

export const a2uiModule: NativeToolModule = {
  defs: {
    [A2UI_PUSH_NAME]: a2uiPushToolDef,
    [A2UI_RESET_NAME]: a2uiResetToolDef,
  },
  handlers: {
    [A2UI_PUSH_NAME]: handleA2UIPush,
    [A2UI_RESET_NAME]: handleA2UIReset,
  },
  mappings: {
    [A2UI_PUSH_NAME]: { kind: "tool", id: "a2ui" },
    [A2UI_RESET_NAME]: { kind: "tool", id: "a2ui" },
  },
  enabled: () => isCapabilityEnabled("tool", "a2ui"),
};
