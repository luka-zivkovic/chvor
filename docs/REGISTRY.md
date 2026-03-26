# Chvor Registry Specification

This document defines the contract between a chvor registry service and the chvor client. Any service that conforms to this spec can serve as a registry.

## Overview

A registry is an HTTP service that serves two things:
1. An **index** (`index.json`) — a manifest of all published entries
2. **Content files** — the actual `.md` files for each entry

The chvor client fetches the index to browse/search, then fetches individual files to install.

## URL Structure

Given a base URL (e.g. `https://registry.chvor.com/v1`), the client expects:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `{base}/index.json` | GET | Full registry index |
| `{base}/skills/{id}/skill.md` | GET | Skill content file |
| `{base}/tools/{id}/tool.md` | GET | Tool content file (future) |
| `{base}/templates/{id}/template.yaml` | GET | Template manifest (future) |

The base URL is configurable per-installation via `registry-lock.json`. The default is set in `registry-client.ts`.

## Index Format (`index.json`)

```json
{
  "version": 2,
  "updatedAt": "2026-03-19T12:00:00Z",
  "entries": [
    {
      "id": "web-search",
      "kind": "skill",
      "name": "Web Search",
      "description": "Search the web and summarize results",
      "version": "1.2.0",
      "author": "janedoe",
      "category": "web",
      "tags": ["search", "research"],
      "license": "MIT",
      "downloads": 142,
      "sha256": "a1b2c3d4e5f6...",
      "requires": {
        "credentials": ["brave-api"]
      },
      "dependencies": ["json-formatter"]
    }
  ]
}
```

### Index Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `number` | yes | Schema version. Current: `2` |
| `updatedAt` | `string` (ISO 8601) | yes | When the index was last regenerated |
| `entries` | `RegistryEntry[]` | yes | All published entries |

### Entry Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique slug (lowercase, alphanumeric + hyphens). Used as filename and URL path segment. |
| `kind` | `"skill" \| "tool" \| "template"` | yes | Entry type |
| `name` | `string` | yes | Human-readable display name |
| `description` | `string` | yes | One-line description |
| `version` | `string` | yes | Semver (e.g. `1.2.0`) |
| `author` | `string` | no | Author name or handle |
| `category` | `string` | no | One of: `ai`, `communication`, `data`, `developer`, `file`, `productivity`, `web` |
| `tags` | `string[]` | no | Searchable tags |
| `license` | `string` | no | License identifier (e.g. `MIT`, `Apache-2.0`) |
| `downloads` | `number` | no | Download count (managed by registry service) |
| `sha256` | `string` | yes | SHA-256 hex digest of the content file. Used for integrity checks and user-modification detection. |
| `requires` | `object` | no | `{ env?: string[], credentials?: string[] }` — runtime requirements |
| `dependencies` | `string[]` | no | IDs of other registry entries that should be co-installed |
| `includes` | `string[]` | no | For templates only: IDs of skills/tools bundled in the template |

### SHA-256 Computation

The `sha256` field is the hex-encoded SHA-256 hash of the raw content file (UTF-8 encoded). In Node.js:

```js
const crypto = require("crypto");
const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
```

This hash serves two purposes:
1. **Integrity** — verify downloaded content matches the index
2. **User modification detection** — if the installed file's hash differs from the lockfile's hash, the user has edited it locally, and auto-update will skip it

## Content File Format

### Skills (`skills/{id}/skill.md`)

A skill is a Markdown file with YAML frontmatter:

```markdown
---
name: Code Review
description: Systematic code review with actionable feedback
version: 1.0.0
author: chvor-team
type: workflow
category: developer
icon: code
tags:
  - code-review
  - development
  - quality
requires:
  credentials:
    - github-token
config:
  - name: maxIssues
    type: number
    description: Maximum issues to report
    default: 10
  - name: style
    type: string
    description: Review style (brief or detailed)
    default: detailed
dependencies:
  - json-formatter
---

When the user shares code for review, follow this systematic process:

1. **Understand context**: Identify the language, framework, and purpose.
2. **Check correctness**: Look for bugs, logic errors, edge cases.
3. **Security scan**: Flag potential security issues.
...
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Display name |
| `description` | `string` | yes | One-line description |
| `version` | `string` | yes | Semver version |
| `author` | `string` | no | Author |
| `type` | `"prompt" \| "workflow" \| "tool"` | no | Defaults to `prompt`. If `tool` or has `mcp` block, parsed as a Tool. |
| `category` | `string` | no | Skill category |
| `icon` | `string` | no | Icon identifier |
| `tags` | `string[]` | no | Tags |
| `license` | `string` | no | License |
| `requires.env` | `string[]` | no | Required environment variables |
| `requires.credentials` | `string[]` | no | Required credential names |
| `config` | `SkillConfigParam[]` | no | Configurable parameters (see below) |
| `dependencies` | `string[]` | no | Registry entry IDs this depends on |
| `inputs` | `CapabilityParam[]` | no | Input parameters for the skill |
| `outputs` | `CapabilityParam[]` | no | Output parameters |

### Config Parameters

Skills can declare configurable parameters that users can set via the UI or API:

```yaml
config:
  - name: maxResults
    type: number        # "string" | "number" | "boolean"
    description: Maximum results to return
    default: 10
```

These are stored per-skill in the config database as `skill.config.{skillId}.{paramName}`.

### Tools (`tools/{id}/tool.md`)

Tools follow the same format but include an `mcp` block:

```markdown
---
name: GitHub Integration
description: Interact with GitHub repositories
version: 2.0.0
type: tool
category: developer
mcp:
  command: npx
  args:
    - -y
    - "@modelcontextprotocol/server-github"
  transport: stdio
  env:
    GITHUB_TOKEN: "${GITHUB_TOKEN}"
requires:
  credentials:
    - github-token
---

Instructions for using the GitHub tool...
```

### Templates (future)

Templates will be served as `templates/{id}/template.yaml` plus optional bundled skills/tools. This format is defined in `packages/shared/src/types/template.ts` and will be specified when template registry support is implemented (see issue #56).

## Client Behavior

### Installation Flow

1. Client fetches `index.json` from the registry URL
2. User selects an entry to install
3. Client fetches `skills/{id}/skill.md` (or `tools/{id}/tool.md`)
4. File is written to `~/.chvor/skills/{id}.md` (or `~/.chvor/tools/{id}.md`)
5. SHA-256 of the content is computed and stored in `~/.chvor/data/registry-lock.json`
6. Dependencies listed in the entry are recursively installed
7. Capability loader is reloaded; WebSocket `skills.reloaded` event is broadcast

### Lockfile (`~/.chvor/data/registry-lock.json`)

Tracks installed registry entries locally:

```json
{
  "installed": {
    "web-search": {
      "kind": "skill",
      "version": "1.2.0",
      "installedAt": "2026-03-19T10:00:00Z",
      "sha256": "a1b2c3d4e5f6...",
      "source": "registry",
      "userModified": false
    }
  },
  "registryUrl": "https://registry.chvor.com/v1",
  "lastChecked": "2026-03-19T10:00:00Z"
}
```

### Update Detection

The client periodically (default: every 6 hours) fetches `index.json` and compares:
- Entry `version` vs lockfile `version` (semver comparison)
- Entry `sha256` vs lockfile `sha256`

If the installed file's current SHA-256 differs from the lockfile's SHA-256, the file was locally modified (`userModified: true`), and auto-update is skipped unless forced.

### Offline Behavior

If the registry is unreachable:
- The client uses a locally cached copy of `index.json` (stored at `~/.chvor/data/registry-index-cache.json`)
- Already-installed skills continue to work (they're local `.md` files)
- Install/update operations fail gracefully with an error message

### Search

The client searches the index locally (after fetching/caching it).

**Text search** matches against: `id`, `name`, `description`, and `tags` (case-insensitive substring match).

**Filters:**
- `category` — exact match against the entry's category field
- `kind` — exact match: `"skill"`, `"tool"`, or `"template"`
- `tags` — all specified tags must be present on the entry (AND logic)

## Validation Rules

Before an entry is accepted into the registry, it should pass these checks:

### Required
- Valid YAML frontmatter with `name`, `description`, `version`, `author`
- Version is valid semver (`X.Y.Z`)
- No embedded secrets (API keys, private keys, AWS credentials)
- Content size under 50KB

### For Tools (security-critical)
- `mcp.command` should be from an allowlist of known-safe executors
- No hardcoded credentials in `mcp.env`
- `mcp.transport` must be `stdio` or `http`

### Recommended
- Category is set (improves discoverability)
- Tags are present
- License is declared

The validation logic is implemented in `packages/shared/src/lib/validate-skill.ts` and can be reused by the registry service.

## Caching Headers

The registry service should set appropriate cache headers:

| Endpoint | Cache Strategy |
|----------|---------------|
| `index.json` | Short TTL (5-15 min) or `no-cache` with ETag |
| `skills/{id}/skill.md` | Long TTL (24h+) — content is immutable per version |

When a new version of an entry is published, the `index.json` is regenerated with the new SHA-256. The old content URL can still be cached since versioned content doesn't change.

## Registry Service API

The registry service (separate project, see issue #54) must expose these public endpoints. The chvor client consumes the first two directly; the rest are for the creator portal and admin tooling.

### Public Endpoints (consumed by chvor client)

These are the only two endpoints that the chvor app calls directly. Everything else is internal to the registry service.

| Endpoint | Method | Response | Description |
|----------|--------|----------|-------------|
| `/v1/index.json` | GET | `RegistryIndex` JSON | Full index of all published entries. Must match the schema above exactly. |
| `/v1/skills/{id}/skill.md` | GET | Raw markdown (text/plain) | Content file for a skill. The response body is saved directly to disk. |
| `/v1/tools/{id}/tool.md` | GET | Raw markdown (text/plain) | Content file for a tool (future, issue #55). |

**CORS**: The service should allow `GET` requests from any origin (chvor runs on `localhost` with varying ports).

**Content-Type**: `index.json` must be `application/json`. Content files must be `text/plain` or `text/markdown`.

### Submission Endpoints (creator portal)

| Endpoint | Method | Auth | Body | Description |
|----------|--------|------|------|-------------|
| `/v1/submissions` | POST | GitHub OAuth | `SubmissionRequest` | Submit a new skill/tool for review |
| `/v1/submissions/:id` | GET | GitHub OAuth | — | Check submission status |
| `/v1/submissions/:id` | PATCH | GitHub OAuth | `SubmissionUpdateRequest` | Update a pending submission |
| `/v1/submissions` | GET | GitHub OAuth | — | List your submissions |

**Submission request body:**

```json
{
  "id": "my-skill",
  "kind": "skill",
  "content": "---\nname: My Skill\n...\n---\n\nInstructions here...",
  "changelog": "Initial release"
}
```

The `content` field is the full `.md` file content (frontmatter + body). The registry service extracts `name`, `description`, `version`, `author`, `category`, `tags` from the YAML frontmatter — creators don't need to duplicate these fields.

**Submission update body (for revisions before approval):**

```json
{
  "content": "---\nname: My Skill\n...\n---\n\nUpdated instructions...",
  "changelog": "Fixed typo in step 3"
}
```

Only `content` and `changelog` can be updated. The `id` and `kind` are immutable after creation.

**Submission status model:**

```
draft → pending_review → in_review → approved → published
                       ↘ changes_requested → pending_review (resubmit)
                       ↘ rejected (terminal)
```

| Status | Meaning |
|--------|---------|
| `draft` | Saved but not yet submitted (future, if portal supports drafts) |
| `pending_review` | Submitted, waiting in queue |
| `in_review` | An admin has opened this for review |
| `changes_requested` | Admin requested changes; creator can update and resubmit |
| `approved` | Passed review, ready to publish |
| `published` | Live in the registry index |
| `rejected` | Declined (with reason). Creator can submit a new entry. |

**Submission response shape (from GET):**

```json
{
  "id": "sub_abc123",
  "entryId": "my-skill",
  "kind": "skill",
  "status": "pending_review",
  "version": "1.0.0",
  "name": "My Skill",
  "author": "janedoe",
  "content": "---\n...",
  "changelog": "Initial release",
  "createdAt": "2026-03-19T10:00:00Z",
  "updatedAt": "2026-03-19T10:00:00Z",
  "reviewComment": null,
  "reviewedBy": null,
  "validationErrors": [],
  "validationWarnings": ["No license declared"]
}
```

### Admin Endpoints (review pipeline)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/admin/queue` | GET | Admin token | List pending submissions for review |
| `/v1/admin/queue/:id` | GET | Admin token | View submission detail with content preview |
| `/v1/admin/review/:id` | PATCH | Admin token | Review a submission (see body below) |
| `/v1/admin/publish/:id` | POST | Admin token | Publish an approved submission to the live index |
| `/v1/admin/entries/:id` | DELETE | Admin token | Unpublish / remove a live entry |
| `/v1/admin/audit` | GET | Admin token | Audit log of all review actions |

**Review request body:**

```json
{
  "action": "approve",
  "comment": "Looks good, clear instructions."
}
```

`action` is one of: `"approve"`, `"reject"`, `"request_changes"`.

**Queue list response:**

```json
{
  "data": [
    {
      "id": "sub_abc123",
      "entryId": "my-skill",
      "kind": "skill",
      "status": "pending_review",
      "version": "1.0.0",
      "name": "My Skill",
      "author": "janedoe",
      "createdAt": "2026-03-19T10:00:00Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 50
}
```

**Audit log entry:**

```json
{
  "id": "audit_xyz",
  "submissionId": "sub_abc123",
  "entryId": "my-skill",
  "action": "approve",
  "comment": "Looks good",
  "adminId": "admin-luka",
  "timestamp": "2026-03-19T11:00:00Z"
}
```

### Publishing Flow (what happens when admin clicks "Publish")

1. Validate the submission content one final time (auto-checks)
2. Write the content file to storage (`skills/{id}/skill.md`)
3. Compute the SHA-256 of the content
4. Add or update the entry in the entries array
5. Increment the `downloads` counter to `0` for new entries (preserve for updates)
6. Set `updatedAt` to current ISO timestamp
7. Regenerate and write `index.json`
8. Invalidate CDN cache for `index.json` (content files are immutable per version, no invalidation needed)

### Submission Validation (auto-checks before entering review queue)

The registry service should run these checks automatically when a submission is received. Failed checks should return specific error messages so creators can fix issues before resubmitting.

```
Required checks (block submission):
  [x] Has valid YAML frontmatter
  [x] Has name, description, version, author fields
  [x] Version is valid semver (X.Y.Z)
  [x] No embedded secrets (regex patterns: sk-*, AKIA*, ghp_*, private keys)
  [x] Content size under 50KB
  [x] ID slug is valid (lowercase alphanumeric + hyphens, 2-50 chars)
  [x] ID does not conflict with existing published entry (unless it's an update by same author)
  [x] For tools: mcp.command is on the allowlist
  [x] For tools: mcp.env values don't contain hardcoded secrets
  [x] For tools: mcp.transport is "stdio" or "http"

Warnings (shown to creator, don't block):
  [ ] No category set
  [ ] No tags set
  [ ] No license declared
  [ ] Description is very short (< 20 chars)
```

The validation logic in `packages/shared/src/lib/validate-skill.ts` implements the required checks and can be imported directly by the registry service if it's built in TypeScript/Node.js.

### ID Rules

Entry IDs must be:
- Lowercase alphanumeric with hyphens only: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`
- Between 2 and 50 characters
- Unique across all entries (skills, tools, and templates share one namespace)
- The ID becomes the filename on disk (`{id}.md`) and the URL path segment

### Version Update Rules

When a creator submits an update to an existing entry:
- The new `version` must be strictly greater than the current published version (semver comparison)
- The `id` and `kind` must match the existing entry
- The `author` must match (or be an admin)

### Error Response Format

All error responses from the registry service should use this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Version must be valid semver (e.g. 1.0.0)",
    "details": [
      { "field": "version", "message": "Invalid format: 'v1' is not valid semver" }
    ]
  }
}
```

Standard error codes:
- `VALIDATION_FAILED` — submission didn't pass auto-checks (400)
- `NOT_FOUND` — entry or submission doesn't exist (404)
- `UNAUTHORIZED` — missing or invalid auth token (401)
- `FORBIDDEN` — valid auth but insufficient permissions (403)
- `CONFLICT` — ID already taken by another author (409)
- `RATE_LIMITED` — too many requests (429)

### Download Counter

The `downloads` field in the index is incremented by the registry service each time a chvor client fetches a content file (skill.md/tool.md). This happens on install, not on index fetch. The count is approximate — no deduplication per user is required.

### Rate Limiting

Recommended limits:
- **Public endpoints** (index.json, content files): 60 requests/minute per IP. These are cached locally by chvor, so high rates indicate misconfiguration or abuse.
- **Submission endpoints**: 10 requests/minute per authenticated user.
- **Admin endpoints**: No rate limit (trusted).

### Pagination

The `index.json` file is served as a single document (no pagination). For registries with thousands of entries, this could grow to several MB. This is acceptable because:
1. Chvor caches the index locally and only re-fetches periodically
2. The index is highly compressible (gzip brings typical indexes under 100KB)
3. The registry service should set `Content-Encoding: gzip` on the response

If the index exceeds 5MB uncompressed, consider splitting into category-specific indexes (e.g. `/v1/index/web.json`) as a future optimization. The current client implementation does not support split indexes.

## Chvor Internal API Endpoints

These are the endpoints that the chvor server exposes locally for its own UI and CLI to interact with the registry. These are NOT part of the registry service — they run inside the user's chvor instance.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/registry/search?q=&category=&tags=` | GET | Search/filter entries from cached index |
| `/api/registry/skill/:id` | GET | Single entry detail + install status |
| `/api/registry/install` | POST | Install an entry. Body: `{ skillId: string }` |
| `/api/registry/skill/:id` | DELETE | Uninstall a registry entry |
| `/api/registry/updates` | GET | Check for available updates |
| `/api/registry/update` | POST | Apply updates. Body: `{ skillId?: string, all?: boolean, force?: boolean }` |
| `/api/registry/refresh` | POST | Re-fetch `index.json` from registry |

## CLI Commands

```bash
chvor skill search <query>       # Search the registry
chvor skill install <id>         # Install from registry
chvor skill uninstall <id>       # Remove a registry entry
chvor skill update [id]          # Update one or all entries
chvor skill list                 # List all installed skills
chvor skill info <id>            # Show entry details
chvor skill publish <file>       # Validate for publishing
```

## Building a Registry Service — Quickstart

The minimal viable registry is surprisingly simple. You need to serve two static files over HTTP:

### 1. Create an `index.json`

```json
{
  "version": 2,
  "updatedAt": "2026-03-19T12:00:00Z",
  "entries": []
}
```

### 2. Add a skill

Create `skills/my-skill/skill.md`:

```markdown
---
name: My Skill
description: Does something useful
version: 1.0.0
author: yourname
category: productivity
tags:
  - example
---

Instructions for the AI go here.
```

### 3. Compute the SHA-256 and add to index

```bash
shasum -a 256 skills/my-skill/skill.md
# outputs: abc123...  skills/my-skill/skill.md
```

Add to `index.json`:

```json
{
  "version": 2,
  "updatedAt": "2026-03-19T12:00:00Z",
  "entries": [
    {
      "id": "my-skill",
      "kind": "skill",
      "name": "My Skill",
      "description": "Does something useful",
      "version": "1.0.0",
      "author": "yourname",
      "category": "productivity",
      "tags": ["example"],
      "sha256": "abc123...",
      "downloads": 0
    }
  ]
}
```

### 4. Serve it

Any static file server works. For development:

```bash
npx serve .
# Registry is now at http://localhost:3000
```

Then in chvor, edit `~/.chvor/data/registry-lock.json`:

```json
{
  "installed": {},
  "registryUrl": "http://localhost:3000",
  "lastChecked": ""
}
```

Now `chvor skill search "my"` will find your skill, and `chvor skill install my-skill` will install it.
