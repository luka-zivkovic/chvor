# A2UI — Agent-to-User Interface

A2UI is Chvor's protocol for **agent-generated dynamic UIs**. Instead of responding with plain text, the AI can build dashboards, charts, tables, forms, and interactive layouts directly on a dedicated Canvas page.

---

## Overview

When A2UI is enabled, the AI gets two native tools:

| Tool                            | Purpose                                                |
| ------------------------------- | ------------------------------------------------------ |
| **native\_\_canvas_a2ui_push**  | Push UI components, set the render root, and bind data |
| **native\_\_canvas_a2ui_reset** | Clear one or all surfaces                              |

The AI uses these tools when you ask it to "build a dashboard", "show a chart", "display a table", or create any visual interface.

A2UI surfaces can also be **interactive**. Buttons and forms may use the safe
action grammar `navigate:<panelId>`, `emit:<eventName>[?json]`, or `noop`.
`emit:*` actions are posted back to Chvor as daemon work through the A2UI action
endpoint.

---

## Enabling A2UI

A2UI is **disabled by default** to avoid adding tool definitions to the system prompt when not needed.

To enable it:

1. Open the **Tools** panel on the Brain Canvas
2. Find **A2UI Canvas** and toggle it on
3. The AI will now have access to the A2UI tools

Or via API:

```
PATCH /api/tools/a2ui/toggle
{ "enabled": true }
```

---

## How It Works

### Protocol Flow

```
User: "Build me a system status dashboard"
   │
   ▼
AI calls native__canvas_a2ui_push with:
   1. surfaceUpdate  → registers components (Text, Chart, Table, etc.)
   2. beginRendering → sets the root component, starts display
   3. dataModelUpdate → populates bound data values
   │
   ▼
Server persists surface to SQLite, emits WebSocket events
   │
   ▼
Client renders the component tree on the Canvas page
   │
   ▼
Toast notification: "Surface ready — Open Canvas"
   │
   ▼
User clicks Button/Form
   │
   ▼
Client validates safe action grammar, server verifies surface + source component
   │
   ▼
Server queues daemon work and starts a cognitive loop for the UI action
```

### Architecture

```
┌─────────────┐    native tools     ┌─────────────┐
│   AI Agent   │ ─────────────────► │   Server     │
│ (Orchestrator)│                    │  native-tools│
└─────────────┘                     │  a2ui-store  │
                                    │  (SQLite)    │
                                    └──────┬───────┘
                                           │ WebSocket events
                                           │ a2ui.surface / a2ui.data / a2ui.delete
                                           ▼
                                    ┌─────────────┐
                                    │   Client     │
                                    │  a2ui-store  │
                                    │  A2UIRenderer│
                                    │  CanvasPage  │
                                    └─────────────┘
```

---

## Components

The AI can compose these building blocks:

| Component  | Description                                 | Key Props                                        |
| ---------- | ------------------------------------------- | ------------------------------------------------ |
| **Text**   | Headings, body, captions, code              | `text`, `usageHint` (h1/h2/h3/body/caption/code) |
| **Column** | Vertical flex layout                        | `children`, `gap`, `align`                       |
| **Row**    | Horizontal flex layout                      | `children`, `gap`, `align`                       |
| **Image**  | Display images (http/https/data:image only) | `src`, `alt`, `width`, `height`                  |
| **Table**  | Tabular data with headers                   | `columns[{key, label}]`, `rows`                  |
| **Button** | Interactive button                          | `label`, `action`, `variant`                     |
| **Form**   | Form container with submit                  | `children`, `submitAction`, `submitLabel`        |
| **Input**  | Text input field                            | `placeholder`, `bindTo`, `inputType`             |
| **Chart**  | Bar or line chart (SVG)                     | `chartType`, `data`, `title`                     |

---

## Data Binding

Text values can be either literal or bound to a data model:

```json
// Literal — static text
{ "literalString": "System Status" }

// Bound — resolved from data bindings via dot-path
{ "binding": "metrics.cpu" }
```

Bound values update in-place when the AI sends a `dataModelUpdate` message, without rebuilding the component tree. This is how the AI can push live data updates to an existing dashboard.

---

## Canvas Page

The Canvas page is a dedicated full-screen view with:

- **Sidebar** — lists all surfaces with timestamps, click to select, hover to delete
- **Viewer** — renders the active surface's component tree

Access it by:

- Clicking the **A2UI Canvas** node on the Brain Canvas
- Clicking "Open Canvas" on the toast notification

Press **Esc** to return to the main Brain view.

---

## Surfaces

A **surface** is a named UI instance. The AI can create multiple surfaces (e.g., "system-dashboard", "user-list", "analytics"). Each has:

- A unique `surfaceId`
- A component tree (max 500 components)
- A data bindings object
- A root component that anchors the render tree

Surfaces are persisted in a separate SQLite database (`data/a2ui.db`) and survive server restarts.

### REST API

| Method | Endpoint                 | Description                                      |
| ------ | ------------------------ | ------------------------------------------------ |
| GET    | `/api/a2ui/surfaces`     | List all surfaces                                |
| GET    | `/api/a2ui/surfaces/:id` | Get full surface with components and bindings    |
| PATCH  | `/api/a2ui/surfaces/:id` | Update surface title                             |
| POST   | `/api/a2ui/actions`      | Dispatch a validated Button/Form `emit:*` action |
| DELETE | `/api/a2ui/surfaces/:id` | Delete a surface                                 |

### Action dispatch

Button and Form actions are intentionally narrow:

- `navigate:<panelId>` opens a known in-app panel client-side.
- `emit:<eventName>[?json]` queues daemon work through `POST /api/a2ui/actions`.
- `noop` renders an explicitly inert component.

For `emit:*`, the client sends `{ surfaceId, sourceId, eventName, payload }`.
The server rejects the dispatch unless:

1. the surface exists,
2. `sourceId` points to a Button or Form on that surface, and
3. the stored component action emits the same `eventName`.

Button payloads are canonicalized from the persisted `emit:*` JSON; the request
payload must match it. Form actions may add submitted input values only under
`payload.form`; persisted top-level payload fields cannot be overridden by the
client request.

This prevents arbitrary clients from spoofing actions for a surface or turning a
non-interactive component into daemon work, and prevents one valid button or form
from being replayed with a different top-level action payload.

After a valid `emit:*` dispatch, the client tracks the returned daemon task and
updates the Button/Form affordance as the task moves through queued, running,
completed, failed, or cancelled states. If the task is linked to a cognitive
loop, the client selects that loop so the rail can show the live action history.

---

## Security

- **Image sources** are validated against an allowlist (http/https, data:image/\*, relative paths). `javascript:` and `data:text/html` are blocked.
- **Data binding paths** block prototype pollution (`__proto__`, `constructor`, `prototype`).
- **Actions** are allowlisted (`navigate:*`, `emit:*`, `noop`) and re-validated server-side against the persisted surface component before daemon work is queued. Button payloads must match the persisted action payload; forms can add only sanitized `payload.form` field values.
- **Recursive rendering** is capped at depth 50 with circular reference detection.
- **Component count** is capped at 500 per surface to prevent memory exhaustion.
- A2UI is disabled by default — enabling it adds the tools to the AI's system prompt.

---

## Limitations (v0.9)

- **Actions are intentionally sandboxed** — only in-app navigation and `emit:*` daemon work are supported; raw URLs and arbitrary JavaScript are blocked.
- **Input fields submit only through their containing Form** — standalone inputs render, but do not dispatch by themselves.
- **No pie charts** — only bar and line charts are supported. Pie chart type falls back to bar.
- The AI may occasionally respond with plain text instead of building a UI — prompt it explicitly with "build a dashboard" or "show this as a table".
