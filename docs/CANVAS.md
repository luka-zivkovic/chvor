# Brain Canvas

The brain canvas is Chvor's real-time execution visualizer. It shows the AI's brain at the center with skills, tools, channels, and integrations radiating outward as an interactive constellation. When the AI thinks, you see which components light up.

---

## Layout

```
                    Channels
                   /
     Skills --- Brain --- Tools
                   \
                 Integrations
```

The canvas uses an **orbital layout**:
- **Center**: Brain node (the AI core)
- **Inner ring**: Hub nodes (Skills, Tools, Integrations, Connections)
- **Outer ring**: Individual skills, tools, credentials, schedules, webhooks

Nodes are positioned automatically but can be dragged to customize. Layout persists across sessions.

---

## Node Types

| Node | What it represents | When it lights up |
|------|-------------------|-------------------|
| **Brain** | The AI orchestrator | During every conversation turn |
| **Skill** | A behavioral skill (e.g., Code Review) | When the skill's instructions are used |
| **Tool** | An MCP tool (e.g., GitHub, Web Browse) | When the AI calls that tool |
| **Credential** | A saved API key/token | When used to authenticate a tool call |
| **Schedule** | A cron job | When a scheduled task executes |
| **Webhook** | An event subscription | When a webhook event arrives |
| **Channel** | A messaging platform | When a message arrives/is sent |
| **PC Control** | PC automation | When the AI interacts with a PC |

---

## Execution Animation

When you send a message:

1. **Brain node** pulses and turns active (blue glow)
2. **Edges** to relevant skills/tools animate with flowing particles
3. **Tool nodes** light up as the AI calls them
4. Nodes show status: running (pulse), completed (green flash), failed (red flash)
5. After completion, everything fades back to idle

### Emotion Particles

If emotions are enabled, animated particles orbit the brain node:
- Shape and color reflect the current emotion (curiosity = ?, excitement = star, calm = circle)
- Particles use deterministic seeded animation for consistent appearance

---

## Interaction

- **Click** a node to open its detail panel (skill editor, tool config, credential manager, etc.)
- **Drag** nodes to rearrange the layout
- **Scroll** to zoom in/out
- **MiniMap** in the bottom-right shows an overview of the full constellation

---

## Ghost Nodes (Onboarding)

When features aren't configured yet, the canvas shows "ghost" hub nodes as call-to-action prompts:
- No skills installed? Ghost Skills Hub appears
- No credentials saved? Ghost Integrations Hub appears

Click a ghost node to set up that feature.

---

## Panels

Click the sidebar icons or canvas nodes to open panels:

| Panel | Description |
|-------|-------------|
| **Conversations** | Session history and management |
| **Models** | LLM provider and model selection |
| **Skills** | Skill library with enable/disable toggles |
| **Tools** | MCP tool management |
| **Integrations** | Saved credentials and API keys |
| **Schedules** | Cron job management |
| **Webhooks** | Event subscription management |
| **Memory** | Memory browser and graph |
| **Knowledge** | Document ingestion |
| **Emotions** | Emotion arc history |
| **Activity** | Activity log |
| **Settings** | Persona, voice, session lifecycle, backups |
