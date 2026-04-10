# Credential Management Overhaul — Design Spec

## Context

The previous credential management approach allowed users to paste raw API keys as free text in chat, exposing secrets to the LLM. A partial fix was implemented (inline modal form that keeps secrets out of LLM context), but the changes are flaky and incomplete. Additionally, the system lacks intelligence about what integrations are available and how to use them after connecting.

This overhaul redesigns credential management around a **registry-first, three-tier model** that leverages the existing Chvor registry infrastructure for reliable, curated integrations, with AI research as a last-resort fallback.

## Goals

1. **Safe credential entry** — secrets never touch the chat/LLM layer; always collected via secure form UI
2. **Registry-first discovery** — AI searches the Chvor registry for integrations before resorting to web research
3. **Self-contained tool definitions** — registry tools embed their credential schemas (fields, auth, help text)
4. **Unified UX** — same credential form component used in chat modal and Settings page
5. **Arbitrary credentials** — users can add any credential type, named however they want, with custom fields

## Non-Goals

- Credential entry via Telegram/Discord chat (deferred — unsafe due to secrets in chat history)
- Auto-rotation of credentials
- MCP tool generation from AI research (v2 consideration)
- Migrating LLM/channel providers out of the hardcoded provider registry

---

## Architecture

### Three-Tier Resolution Model

```
Tier 1: Provider Registry (builtin, instant)
  - LLM providers, embedding providers, core channels (Telegram, Slack, Discord, WhatsApp, Matrix)
  - Credential fields hardcoded in provider-registry.ts
  - No MCP server — native integrations
  - ~30 providers, stable

Tier 2: Chvor Registry (discoverable, curated)
  - Everything else: GitHub, NocoDB, Jira, Notion, Home Assistant, etc.
  - Tool definition includes MCP config + embedded credential schema
  - Install tool → collect credentials → MCP server spawns with injected credentials
  - Versioned, integrity-checked, auto-updatable

Tier 3: AI Research (fallback, best-effort)
  - Only for services not in either registry
  - Web search (DuckDuckGo) + LLM extraction → ProviderProposal
  - Fallback: pure LLM reasoning if web search fails
  - AI uses native__web_request with discovered capability profile
  - Lower confidence, flagged to user
```

### What Gets Deleted (Start Fresh)

| File | Reason |
|------|--------|
| `credential-type-resolver.ts` | Replaced by three-tier resolution |
| `command-handlers.ts` | No more `/addkey` via chat |
| `connection-config-resolver.ts` | Auth discovery handled by registry tool definitions or AI research |
| Current `native__request_credential` tool | Rewritten for three-tier flow |
| Current `CredentialRequest.tsx` | Rewritten as cleaner shared form component |

### What Stays

| File | Reason |
|------|--------|
| `credential-store.ts` | Encrypted CRUD — solid, well-tested |
| `provider-registry.ts` | Builtin baseline for LLM providers + core channels |
| Registry system (`registry-manager.ts`, `registry-client.ts`, etc.) | Foundation for Tier 2 |
| `AddCredentialDialog.tsx`, `CredentialCard.tsx` | Settings page components (updated, not rewritten) |
| Post-save actions (channel restart, MCP refresh, model cache clear) | Still needed |

---

## Detailed Design

### 1. Registry Tool Credential Schema

Tool entries in the Chvor registry embed their credential requirements in YAML frontmatter:

```yaml
---
name: NocoDB
description: Manage NocoDB databases, tables, and records
version: 1.0.0
category: data
tags: [database, nocodb, api]
mcp:
  command: npx
  args: ["@chvor/mcp-nocodb"]
  transport: stdio
  env:
    NOCODB_TOKEN: "{{credentials.nocodb.apiToken}}"
    NOCODB_BASE_URL: "{{credentials.nocodb.instanceUrl}}"
credentials:
  type: nocodb
  name: NocoDB
  fields:
    - key: apiToken
      label: API Token
      required: true
      secret: true
      helpText: "Find at Settings -> API Tokens in your NocoDB instance"
    - key: instanceUrl
      label: Instance URL
      required: true
      secret: false
      placeholder: "https://nocodb.example.com"
---
```

**Key properties:**
- `credentials.type` — the credential type string used in the credential store
- `credentials.name` — display name for the form
- `credentials.fields[]` — field definitions with `key`, `label`, `required`, `secret`, `helpText`, `placeholder`
- `mcp.env` — references credential fields via `{{credentials.<type>.<fieldKey>}}` placeholders
- **Self-contained** — tool carries everything needed; no dependency on provider registry for field definitions

**Validation:** Registry submission validation (`POST /v1/submissions`) should verify:
- If `credentials` block exists, all `{{credentials.*}}` placeholders in `mcp.env` reference valid field keys
- Required fields have sensible labels
- `credentials.type` follows entry ID format (`/^[a-z0-9][a-z0-9_-]*$/`)

### 2. Chat Flow (AI-Initiated)

**Three-step conversation flow:**

**Step 1 — Research:**
User says "I want to connect NocoDB" (or similar intent).

AI executes `native__research_integration` tool:
- Checks provider registry (Tier 1) → if found, returns provider definition
- Searches Chvor registry (Tier 2) → if found, returns tool entry with credential schema
- Falls back to AI research (Tier 3) → web search + LLM extraction

Tool returns a `IntegrationResolution`:
```typescript
type IntegrationResolution = {
  source: "provider-registry" | "chvor-registry" | "ai-research";
  // Tier 1
  provider?: ProviderDefinition;
  // Tier 2
  registryEntry?: RegistryEntry;
  credentialSchema?: CredentialSchema;  // from tool's credentials block
  // Tier 3
  proposal?: ProviderProposal;
};
```

**Step 2 — Confirm with user:**
AI presents findings conversationally:
- Tier 1: "Anthropic is a supported LLM provider. You'll need an API key. Ready to add it?"
- Tier 2: "NocoDB is available in the Chvor registry. I can install the NocoDB tool which needs an API Token and your Instance URL. Want to proceed?"
- Tier 3: "I couldn't find NocoDB in our registries, but I researched it. It appears to use token-based auth. I can set up a generic connection — you'll need an API token and your instance URL. Want to try?"

User confirms (or adjusts).

**Step 3 — Credential form:**
AI calls `native__request_credential` with the resolution data.
- For Tier 2: tool is installed first via registry-manager, then credential form shown
- Inline modal appears in chat with fields from the resolution
- User fills in values, can add/remove/edit fields
- Submit → save to credential store → auto-test → post-save actions
- For Tier 2: MCP server spawns with credentials injected

### 3. Settings Flow (User-Initiated)

**Settings → Integrations page redesign:**

**Section layout:**
1. **Installed** — current credentials with status, edit, delete, test
2. **Available from Registry** — browsable/searchable Chvor registry tools (reuses existing RegistryBrowserPanel filtered to tools with credentials)
3. **Custom Integration** — manual form for completely custom credentials

**Available from Registry flow:**
- User searches or browses registry tools
- Clicks "Install" on a tool (e.g., NocoDB)
- Tool installs from registry
- Credential form appears (fields from tool's `credentials` block)
- User fills in, saves, tool is ready

**Custom Integration flow:**
- User clicks "Custom Integration"
- Enters: integration name, credential type (auto-slugified), and dynamically adds fields (key + label + secret toggle)
- Saves as a generic credential — no MCP server, AI uses `web_request`

**Search with AI research:**
- Search bar at top: "Search integrations..."
- First matches against provider registry + Chvor registry (instant)
- If no match: "Not found. Research this service?" button
- Clicking triggers the AI research service (server-side, not LLM tool call)
- Results populate the custom integration form with suggested fields

### 4. AI Research Service (Tier 3)

**Server-side service** callable by both AI tools and Settings API:

**Endpoint:** `GET /api/integrations/research?q=<service_name>`

**Pipeline:**
```
Input: service name (e.g., "NocoDB")
  |
  +-- Step 1: Web search (DuckDuckGo) for "{service} API authentication documentation"
  |     |
  |     +-- Success: feed search result snippets to lightweight LLM call
  |     |     -> Extract: auth scheme, required fields, base URL pattern, help text
  |     |     -> Return ProviderProposal with confidence: "researched"
  |     |
  |     +-- Failure (no results / scraping blocked)
  |           -> Fall through to Step 2
  |
  +-- Step 2: Pure LLM reasoning (no web data)
        -> Use model's training knowledge about the service
        -> Return ProviderProposal with confidence: "inferred"
        -> Help text includes: "Based on AI knowledge, may not be current"
```

**LLM call:** Uses the `lightweight` LLM role (cheap/fast model) with a focused extraction prompt.

**ProviderProposal type:**
```typescript
type ProviderProposal = {
  name: string;              // "NocoDB"
  credentialType: string;    // "nocodb"
  fields: ProviderField[];   // [{ key, label, required, secret, helpText }]
  baseUrl?: string;          // suggested base URL pattern
  authScheme?: string;       // "bearer" | "header" | "query"
  helpText?: string;         // general setup guidance
  confidence: "researched" | "inferred";
};
```

### 5. Credential Form Component (Shared)

**Single React component** used by both chat modal and Settings page.

**Props:**
```typescript
type CredentialFormProps = {
  // What to display
  providerName: string;
  providerIcon?: string;
  fields: ProviderField[];
  suggestedName?: string;
  confidence?: "registry" | "researched" | "inferred";

  // Behavior
  allowFieldEditing: boolean;  // can user add/remove fields
  onSubmit: (data: CredentialFormData) => void;
  onCancel: () => void;

  // For updates
  existingCredentialId?: string;
  redactedValues?: Record<string, string>;
};
```

**Features:**
- Required fields rendered as form inputs (password for secrets, text for URLs/IDs)
- Optional fields in collapsible section
- Help text per field (from registry or research)
- Confidence banner: "From Chvor Registry" (green), "Based on web research" (yellow), "Based on AI knowledge" (orange)
- Editable field list: user can add custom fields (key + value + secret toggle) or remove AI-suggested ones
- Credential name field (auto-suggested, editable)
- No timeout — user takes as long as needed
- For updates: shows redacted current values, empty inputs = keep current

### 6. Native Tools (Rewritten)

**`native__research_integration`** (new)
- Input: `{ service: string }` — service name or description
- Process: three-tier resolution (provider registry → Chvor registry → AI research)
- Output: `IntegrationResolution` with source, credential schema, and guidance
- AI uses the output to present findings and decide next step

**`native__request_credential`** (rewritten)
- Input: `{ resolution: IntegrationResolution, existingCredentialId?: string }`
- Process:
  - If Tier 2 and tool not installed: install via registry-manager first
  - Send `credential.request` WebSocket event with resolved fields
  - Wait for `credential.respond` (no timeout — clean up on disconnect)
  - Save credential, auto-test, run post-save actions
- Output: credential ID and test status

**Removed tools:**
- `native__add_credential` — replaced by `native__request_credential`

**Kept tools (unchanged):**
- `native__list_credentials`
- `native__use_credential`
- `native__update_credential`
- `native__test_credential`
- `native__delete_credential`

### 7. Post-Save Actions

After any credential is created or updated:

1. **Auto-test** — hit the API with credentials to verify they work, update `testStatus`
2. **Channel restart** — if credential type matches a channel adapter (telegram, discord, slack, whatsapp, matrix)
3. **MCP refresh** — `invalidateToolCache()` + close MCP connections for tools depending on this credential type
4. **Model cache clear** — if credential is an LLM provider type
5. **Store capability metadata** — for Tier 3 (researched) credentials, store the ProviderProposal as `usageContext` for future AI reference

### 8. Credential Updates & Rotation

**From Settings:**
- CredentialCard → Edit → same form with redacted values → update fields → post-save actions

**From Chat:**
- User: "update my NocoDB key"
- AI calls `native__request_credential` with `existingCredentialId`
- Modal shows current fields (redacted), user updates what they need
- Empty fields = keep current value

**Multiple credentials per type:**
- Supported — e.g., "GitHub Personal" and "GitHub Work"
- AI disambiguates by credential name when multiple exist
- Settings page groups credentials by type

### 9. Edge Case: Tool Installed Without Credentials

When a registry tool is already installed but its required credentials haven't been added:
- The tool's MCP server will fail to spawn (missing env vars)
- Settings page shows the tool with a "Credentials needed" badge
- AI detects this via `native__research_integration` — returns the tool's credential schema from the installed tool definition on disk
- User is prompted to add credentials without re-installing the tool

### 10. Error Handling

**Research failures (Tier 3):**
- Web search fails → fall back to pure LLM inference, flag as low confidence
- LLM fails → return generic form (apiKey + baseUrl), AI tells user it couldn't find docs
- Both fail → AI directs user to add manually via Settings → Custom Integration

**Credential test failures:**
- Credential saved with `testStatus: "failed"`
- AI informs: "Saved, but the test failed. Check if the key is correct."
- User can re-test or edit — no auto-deletion

**Form errors:**
- Required field missing → form validation prevents submit
- Cancel/dismiss → no credential saved, AI informed of cancellation
- WebSocket disconnect → credential request cleaned up on reconnect (no dangling promises)

**Registry install failures:**
- Tool install fails → AI falls back to Tier 3 (research) or suggests manual setup
- Network issues → AI informs user and suggests retrying

### 10. Base URL Handling

- User provides their **instance URL** (e.g., `https://nocodb.myserver.com`)
- Field labeled "Instance URL" not "API Base URL"
- API path discovery (e.g., `/api/v1`) is the tool's responsibility — baked into the MCP server or capability profile
- For Tier 3 (researched): the LLM extraction step determines the API path and stores it in the capability profile

---

## Data Flow Diagrams

### Chat Flow
```
User: "connect NocoDB"
  |
  v
AI calls native__research_integration("NocoDB")
  |
  +-- Check provider-registry.ts → miss
  +-- Search Chvor registry (GET /api/registry/search?q=nocodb&kind=tool) → hit!
  |
  v
AI: "NocoDB tool found in registry. Needs API Token + Instance URL. Install?"
User: "yes"
  |
  v
AI calls native__request_credential(resolution)
  |
  +-- registry-manager.install("nocodb") → tool installed
  +-- Send credential.request WS event (fields from tool definition)
  |
  v
Client renders CredentialForm modal
User fills in apiToken + instanceUrl → clicks Save
  |
  v
Client sends credential.respond WS event
  |
  +-- credential-store.createCredential() → encrypted in SQLite
  +-- Auto-test credential
  +-- MCP manager spawns nocodb MCP server with injected credentials
  |
  v
AI now has typed NocoDB tools (list_tables, create_row, etc.)
```

### Settings Flow
```
User opens Settings → Integrations
  |
  v
Sees three sections:
  [Installed]  [Available from Registry]  [Custom Integration]
  |
  v
Clicks "Available from Registry" → browses/searches
Finds NocoDB tool → clicks "Install"
  |
  v
registry-manager.install("nocodb") → tool installed
Credential form appears (fields from tool's credentials block)
User fills in → saves
  |
  v
Same post-save flow as chat
```

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `apps/server/src/lib/integration-resolver.ts` | Three-tier resolution service |
| `apps/server/src/lib/integration-research.ts` | Tier 3: web search + LLM research |
| `apps/server/src/routes/integrations.ts` | API endpoint for research (`GET /api/integrations/research`) |
| `apps/client/src/components/credentials/CredentialForm.tsx` | Shared credential form component |

### Modified Files
| File | Changes |
|------|---------|
| `apps/server/src/lib/native-tools.ts` | Rewrite `native__request_credential`, add `native__research_integration` |
| `apps/client/src/components/chat/ChatPanel.tsx` | Use new CredentialForm in modal |
| `apps/client/src/stores/app-store.ts` | Update credential request state handling |
| `apps/client/src/hooks/use-gateway.ts` | Update WS event handling (no timeout) |
| `apps/server/src/gateway/ws.ts` | Update credential respond handler (no timeout) |
| `apps/client/src/components/panels/SettingsPanel.tsx` | Add registry browsing + custom integration sections |
| `apps/client/src/components/credentials/AddCredentialDialog.tsx` | Adapt to use shared CredentialForm |
| `packages/shared/src/types/api.ts` | Update credential request/response types |
| `packages/shared/src/types/credential.ts` | Add ProviderProposal, IntegrationResolution types |

### Deleted Files
| File | Reason |
|------|--------|
| `apps/server/src/lib/credential-type-resolver.ts` | Replaced by integration-resolver |
| `apps/server/src/lib/command-handlers.ts` | No more /addkey in chat |
| `apps/server/src/lib/connection-config-resolver.ts` | Auth discovery in tool definitions or research |
| `apps/client/src/components/chat/CredentialRequest.tsx` | Replaced by shared CredentialForm |

---

## Verification Plan

1. **Chat flow — known provider (Tier 1):**
   - Say "add Anthropic API key" in chat
   - AI should identify from provider registry, show credential form
   - Fill in API key → verify saved, test passes, models refresh

2. **Chat flow — registry tool (Tier 2):**
   - Say "connect GitHub" in chat (assuming GitHub tool in registry)
   - AI should find in Chvor registry, offer to install
   - Confirm → tool installs, credential form appears with fields from tool definition
   - Fill in → verify MCP server spawns, typed tools available

3. **Chat flow — unknown service (Tier 3):**
   - Say "connect some-obscure-api" in chat
   - AI should search registries (miss), fall back to web research
   - Verify research results shown with confidence flag
   - Fill in form → verify credential saved, AI can use web_request with it

4. **Settings — installed credentials:**
   - Open Settings → Integrations → verify existing credentials shown
   - Edit a credential → verify update works, re-test runs
   - Delete a credential → verify removed, MCP connections closed

5. **Settings — registry browsing:**
   - Open Available from Registry section → verify registry tools listed
   - Install a tool → verify credential form appears with correct fields
   - Fill in → verify tool ready

6. **Settings — custom integration:**
   - Click Custom Integration → add arbitrary fields
   - Save → verify stored correctly
   - Verify AI can reference this credential via native__use_credential

7. **Error cases:**
   - Submit invalid credentials → verify test fails but credential saved
   - Cancel mid-flow → verify no credential created
   - Disconnect during flow → verify no dangling state
   - Registry install fails → verify graceful fallback

8. **Multiple credentials per type:**
   - Add two GitHub credentials with different names
   - Verify AI can disambiguate, Settings shows both
