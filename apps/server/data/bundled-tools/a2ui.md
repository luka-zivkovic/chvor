---
name: A2UI Canvas
description: Build dynamic UIs on the Brain Canvas using the A2UI declarative protocol
version: 0.9.0
category: developer
icon: component
type: tool
defaultEnabled: false
---

You have two A2UI native tools for rendering interactive UIs on the Brain Canvas:

## native\_\_canvas_a2ui_push

Push a declarative UI surface to the canvas. Use this when the user asks you to:

- Build a dashboard, chart, form, or visualization
- Display structured data as a table, card grid, or layout
- Create an interactive interface with buttons, inputs, or forms
- Show real-time or updatable information (metrics, status, progress)

### How to use

Send an array of **messages** in a single call. Each message is one of:

1. **surfaceUpdate** — register components with unique IDs:

```json
{
  "surfaceUpdate": {
    "surfaceId": "my-dashboard",
    "components": [
      {
        "id": "root",
        "component": {
          "Column": { "children": { "explicitList": ["title", "chart1"] }, "gap": 16 }
        }
      },
      {
        "id": "title",
        "component": { "Text": { "text": { "literalString": "System Status" }, "usageHint": "h1" } }
      },
      {
        "id": "chart1",
        "component": {
          "Chart": { "chartType": "bar", "data": { "binding": "metrics" }, "title": "CPU Usage" }
        }
      }
    ]
  }
}
```

2. **beginRendering** — set the root component and start displaying:

```json
{ "beginRendering": { "surfaceId": "my-dashboard", "root": "root" } }
```

3. **dataModelUpdate** — update bound data values without rebuilding the tree:

```json
{
  "dataModelUpdate": {
    "surfaceId": "my-dashboard",
    "bindings": {
      "metrics": [
        { "label": "Core 1", "value": 72 },
        { "label": "Core 2", "value": 45 }
      ]
    }
  }
}
```

### Available components

| Component  | Purpose                        | Key props                                                                              |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| **Text**   | Headings, body, captions, code | `text`, `usageHint` (h1/h2/h3/body/caption/code)                                       |
| **Column** | Vertical flex layout           | `children.explicitList`, `gap`, `align`                                                |
| **Row**    | Horizontal flex layout         | `children.explicitList`, `gap`, `align`                                                |
| **Image**  | Display images                 | `src`, `alt`, `width`, `height`                                                        |
| **Table**  | Tabular data                   | `columns[{key,label}]`, `rows` (binding or literal JSON)                               |
| **Button** | Interactive button             | `label`, `action`, `variant` (primary/secondary/ghost)                                 |
| **Form**   | Form container                 | `children.explicitList`, `submitAction`, `submitLabel`                                 |
| **Input**  | Text input field               | `placeholder`, `bindTo`, `inputType`                                                   |
| **Chart**  | Bar/line/pie charts            | `chartType` (bar/line/pie), `data` (binding or inline array of {label,value}), `title` |

### Interactive actions

Buttons and forms support only this safe action grammar:

- `navigate:<panelId>` — open a known in-app panel on the client.
- `emit:<eventName>[?json]` — queue daemon work through the A2UI action endpoint.
- `noop` — render an explicitly inert component.

Use `emit:*` only for user-approved interactions. The server verifies that the
surface exists, `sourceId` points to the Button/Form, and the persisted action
emits the requested event before any daemon work is queued. For Button payloads,
put the action data in the persisted `emit:*` JSON; clients must echo that
payload exactly. For Form payloads, persisted top-level fields are fixed and the
client may add submitted input values only under `payload.form`.

After dispatch, the client shows queued/running/completed/failed status on the
Button/Form based on the daemon task lifecycle, so clear action labels and task
titles help users understand what is happening.

### Data binding

Text values accept either a literal or a binding reference:

- Literal: `{ "literalString": "Hello" }`
- Bound: `{ "binding": "metrics.cpu" }` — resolved from bindings via dot-path

Use bindings when data will change. Push updates with `dataModelUpdate` to refresh bound values in-place.

### Typical message sequence

Always send all three message types in a single `native__canvas_a2ui_push` call:

1. `surfaceUpdate` with all components
2. `beginRendering` with the root ID
3. `dataModelUpdate` with initial bound data

## native\_\_canvas_a2ui_reset

Clear one or all surfaces. Use when the user says "clear the dashboard" or "remove the UI".

- With `surfaceId`: clears only that surface
- Without: clears all surfaces

## When NOT to use A2UI

- Simple text answers or conversational responses
- When the user just wants information, not a visual interface
- One-off data that doesn't benefit from structured layout
