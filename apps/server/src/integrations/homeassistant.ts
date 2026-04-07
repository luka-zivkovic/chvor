import { z } from "zod";
import { listCredentials, getCredentialData } from "../db/credential-store.ts";
import { assertSafeUrl } from "../lib/url-safety.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function loadCredentials(): { instanceUrl: string; token: string } | null {
  const creds = listCredentials();
  const match = creds.find((c) => c.type === "homeassistant");
  if (!match) return null;
  const full = getCredentialData(match.id);
  if (!full) return null;
  const data = full.data as Record<string, string>;
  if (!data.instanceUrl || !data.token) return null;
  return {
    instanceUrl: data.instanceUrl.replace(/\/+$/, ""),
    token: data.token,
  };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function haFetch(
  creds: { instanceUrl: string; token: string },
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${creds.instanceUrl}${path}`;
  assertSafeUrl(url, "Home Assistant API URL");
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

function formatEntity(entity: HAState, verbose: boolean = false): string {
  const friendly = entity.attributes.friendly_name
    ? String(entity.attributes.friendly_name)
    : entity.entity_id;

  let line = `${entity.entity_id}  ${entity.state}  (${friendly})`;

  if (verbose) {
    const attrs = { ...entity.attributes };
    // Remove bulky attributes for readability
    delete attrs.friendly_name;
    delete attrs.icon;
    delete attrs.entity_picture;
    const attrStr = Object.keys(attrs).length > 0
      ? JSON.stringify(attrs, null, 2)
      : "(no additional attributes)";
    line += `\n  Last changed: ${entity.last_changed}\n  Attributes: ${attrStr}`;
  }

  return line;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function getHomeAssistantTools(): ToolDef[] {
  return [
    // ------ list_entities ------
    {
      name: "ha_list_entities",
      description:
        "List entities from Home Assistant. " +
        "Optionally filter by domain (e.g. 'light', 'switch', 'sensor') or search by friendly name.",
      parameters: z.object({
        domain: z
          .string()
          .optional()
          .describe("Entity domain to filter (e.g. 'light', 'switch', 'sensor', 'climate')"),
        search: z
          .string()
          .optional()
          .describe("Search term to filter by entity ID or friendly name"),
        max_results: z
          .number()
          .optional()
          .describe("Maximum number of entities to return (default 50)"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Home Assistant credentials not configured. Add instance URL and token in Settings → Connections.");

          const resp = await haFetch(creds, "/api/states");
          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`Home Assistant API ${resp.status}: ${body}`);
          }

          let entities = (await resp.json()) as HAState[];
          const maxResults = typeof args.max_results === "number" ? args.max_results : 50;

          // Filter by domain
          if (args.domain) {
            const domain = String(args.domain).toLowerCase();
            entities = entities.filter((e) => e.entity_id.startsWith(`${domain}.`));
          }

          // Filter by search term
          if (args.search) {
            const search = String(args.search).toLowerCase();
            entities = entities.filter(
              (e) =>
                e.entity_id.toLowerCase().includes(search) ||
                (e.attributes.friendly_name &&
                  String(e.attributes.friendly_name).toLowerCase().includes(search))
            );
          }

          // Limit results
          const total = entities.length;
          entities = entities.slice(0, maxResults);

          if (entities.length === 0) {
            return textResult("No entities found matching the criteria.");
          }

          const lines = entities.map((e) => formatEntity(e));
          return textResult(
            `Entities (${entities.length} of ${total}):\n\n${lines.join("\n")}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ get_state ------
    {
      name: "ha_get_state",
      description:
        "Get the current state and attributes of a specific Home Assistant entity.",
      parameters: z.object({
        entity_id: z.string().describe("Entity ID (e.g. 'light.living_room', 'sensor.temperature')"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Home Assistant credentials not configured. Add instance URL and token in Settings → Connections.");

          const entityId = String(args.entity_id);
          const resp = await haFetch(creds, `/api/states/${encodeURIComponent(entityId)}`);

          if (!resp.ok) {
            if (resp.status === 404) {
              return errorResult(`Entity not found: ${entityId}`);
            }
            const body = await resp.text();
            return errorResult(`Home Assistant API ${resp.status}: ${body}`);
          }

          const entity = (await resp.json()) as HAState;
          return textResult(formatEntity(entity, true));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ call_service ------
    {
      name: "ha_call_service",
      description:
        "Call a Home Assistant service to control devices. " +
        "For example, turn on a light, set thermostat temperature, lock a door, etc.",
      parameters: z.object({
        domain: z.string().describe("Service domain (e.g. 'light', 'switch', 'climate', 'lock', 'media_player')"),
        service: z.string().describe("Service name (e.g. 'turn_on', 'turn_off', 'toggle', 'set_temperature')"),
        entity_id: z
          .string()
          .optional()
          .describe("Target entity ID (e.g. 'light.living_room')"),
        data: z
          .record(z.unknown())
          .optional()
          .describe("Additional service data (e.g. { \"brightness\": 255, \"color_name\": \"blue\" })"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Home Assistant credentials not configured. Add instance URL and token in Settings → Connections.");

          const domain = String(args.domain);
          const service = String(args.service);

          const body: Record<string, unknown> = {};
          if (args.entity_id) body.entity_id = String(args.entity_id);
          if (args.data && typeof args.data === "object") {
            Object.assign(body, args.data);
          }

          const resp = await haFetch(
            creds,
            `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
            {
              method: "POST",
              body: JSON.stringify(body),
            }
          );

          if (!resp.ok) {
            const respBody = await resp.text();
            return errorResult(`Home Assistant API ${resp.status}: ${respBody}`);
          }

          // Home Assistant returns the affected states
          const result = (await resp.json()) as HAState[];

          if (Array.isArray(result) && result.length > 0) {
            const affected = result.map((e) => `  ${e.entity_id}: ${e.state}`).join("\n");
            return textResult(
              `Called ${domain}.${service}. Affected entities:\n${affected}`
            );
          }

          return textResult(`Called ${domain}.${service} successfully.`);
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },

    // ------ list_automations ------
    {
      name: "ha_list_automations",
      description:
        "List all Home Assistant automations with their current state (on/off) and last triggered time.",
      parameters: z.object({
        search: z
          .string()
          .optional()
          .describe("Filter automations by name or entity ID"),
      }),
      handler: async (args) => {
        try {
          const creds = loadCredentials();
          if (!creds) return errorResult("Home Assistant credentials not configured. Add instance URL and token in Settings → Connections.");

          const resp = await haFetch(creds, "/api/states");
          if (!resp.ok) {
            const body = await resp.text();
            return errorResult(`Home Assistant API ${resp.status}: ${body}`);
          }

          let entities = (await resp.json()) as HAState[];

          // Filter to automation entities only
          entities = entities.filter((e) => e.entity_id.startsWith("automation."));

          // Optional search filter
          if (args.search) {
            const search = String(args.search).toLowerCase();
            entities = entities.filter(
              (e) =>
                e.entity_id.toLowerCase().includes(search) ||
                (e.attributes.friendly_name &&
                  String(e.attributes.friendly_name).toLowerCase().includes(search))
            );
          }

          if (entities.length === 0) {
            return textResult("No automations found.");
          }

          const lines = entities.map((e) => {
            const name = e.attributes.friendly_name
              ? String(e.attributes.friendly_name)
              : e.entity_id;
            const lastTriggered = e.attributes.last_triggered
              ? String(e.attributes.last_triggered)
              : "never";
            const mode = e.attributes.current
              ? ` (running: ${e.attributes.current})`
              : "";
            return `${e.entity_id}  [${e.state}]  ${name}${mode}\n  Last triggered: ${lastTriggered}`;
          });

          return textResult(
            `Automations (${entities.length}):\n\n${lines.join("\n\n")}`
          );
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
