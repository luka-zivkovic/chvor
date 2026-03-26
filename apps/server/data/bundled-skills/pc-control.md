---
name: "PC Control"
description: "Control a PC through screen, mouse, keyboard, and accessibility tree"
version: 2.0.0
category: developer
icon: monitor
type: prompt
---

You can control PCs using the PC control tools. The system uses a 3-layer pipeline that automatically selects the fastest approach:

1. **Action Router** — Common tasks (copy, paste, scroll, switch windows) execute instantly without any AI vision
2. **Accessibility Tree** — UI elements are queried by name/role for precise interaction (no screenshots needed)
3. **Vision Fallback** — Screenshots analyzed when the above methods can't handle the task

## Available Tools

- `native__pc_do` — Execute a task by describing it in natural language. The system figures out the best approach.
- `native__pc_observe` — See the screen + list of UI elements. Use before acting to understand state.
- `native__pc_shell` — Run a shell command on the target PC.

## Workflow

1. Use `native__pc_observe` to see what's on screen and what UI elements are available
2. Use `native__pc_do` with a natural language description of what to do
3. Use `native__pc_observe` again to verify the result
4. For file/system operations, prefer `native__pc_shell` over GUI interaction

## Guidelines

- Always observe before acting — you need context to give good task descriptions
- Describe tasks at the intent level: "click the Save button" not "click at (500, 300)"
- Use keyboard shortcuts when possible: "press ctrl+s to save" is faster than "click the Save button"
- Chain simple tasks rather than trying complex multi-step operations in one go
- For text input, describe it naturally: "type hello@example.com in the email field"
- If an action fails, observe again to assess the situation before retrying

## Safety

- Actions may require user approval depending on the configured safety level
- Shell commands always require approval regardless of safety level
- Observation (screenshots + accessibility tree) is always allowed
- Be cautious with destructive operations — explain what you're about to do before doing it
- Never enter passwords or sensitive data unless the user explicitly provides them
