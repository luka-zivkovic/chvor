# Channels

Chvor connects to multiple messaging platforms through a unified gateway. Every channel routes messages through the same AI brain, memory system, and tool pipeline. You can talk to the same AI from the web, Telegram, Discord, Slack, and WhatsApp simultaneously.

---

## Supported Channels

| Channel | Setup | Media | Voice | Group Support |
|---------|-------|-------|-------|---------------|
| **Web Chat** | Built-in | Yes | Yes (browser STT/TTS) | N/A |
| **Telegram** | Bot token | Yes | Yes (voice messages) | Yes |
| **Discord** | Bot token | Yes | No | Yes (server channels) |
| **Slack** | Bot + App tokens | Yes | No | Yes (workspace channels) |
| **WhatsApp** | QR code pairing | Yes | Yes (voice messages) | Yes |
| **Matrix** | Homeserver + token | Yes | No | Yes (rooms) |

---

## Setup

### Web Chat

Built-in. Open `http://localhost:3001` and start chatting. No configuration needed.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. Add it in Settings > Integrations, or save as a credential:
   ```
   "Add my Telegram bot token: 123456:ABC-DEF..."
   ```
4. The bot starts listening immediately

### Discord

1. Create a Discord application at [discord.com/developers](https://discord.com/developers/applications)
2. Add a bot, copy the token
3. Enable the **Message Content** intent
4. Invite the bot to your server with the OAuth2 URL generator (scopes: `bot`, permissions: `Send Messages`, `Read Message History`)
5. Add the token in Settings > Integrations

### Slack

Requires two tokens:
1. **Bot Token** (`xoxb-...`) — from your Slack app's OAuth page
2. **App Token** (`xapp-...`) — from your app's Socket Mode settings

Enable Socket Mode in your Slack app settings, then add both tokens in Settings > Integrations.

### WhatsApp

1. Go to Settings > Integrations > WhatsApp
2. Click **Connect** to generate a QR code
3. Scan the QR with WhatsApp on your phone (Linked Devices)
4. Connection persists until you disconnect or the session expires

### Matrix

1. Create a bot account on your Matrix homeserver
2. Generate an access token
3. Add the homeserver URL and token in Settings > Integrations

---

## Channel Policy

Control how the AI responds in DMs vs groups per channel.

```bash
# Get current policy
curl http://localhost:3001/api/whatsapp/policy

# Update policy
curl -X PATCH http://localhost:3001/api/whatsapp/policy \
  -H 'Content-Type: application/json' \
  -d '{"dm": {"mode": "open"}, "group": {"mode": "allowlist"}}'
```

### Modes

| Mode | Behavior |
|------|----------|
| `open` | Responds to everyone |
| `allowlist` | Only responds to approved senders/groups |
| `disabled` | Ignores messages in this context |

### Allowlists

For WhatsApp, allowlists filter by phone number (7-15 digits). For group mode, you can also filter by individual sender within groups via `groupSenderFilter`.

---

## How It Works

```
Telegram/Discord/Slack/WhatsApp/Web
              |
         Gateway (normalize message format)
              |
         Session lookup (channel:id:thread)
              |
         Orchestrator (LLM + tools + memory)
              |
         Response (text, media, voice)
              |
         Channel adapter (format for platform)
```

All channels normalize messages into a common format before reaching the orchestrator. Responses are formatted back to each platform's conventions (Markdown for Discord/Slack, HTML for Telegram, plain text for WhatsApp).

---

## Sessions

Each channel conversation gets its own session, keyed by `{channelType}:{channelId}:{threadId}`. Sessions persist message history, and the AI maintains context across messages within a session.

Sessions can be configured to auto-reset after a period of inactivity via Settings > Session Lifecycle.

---

## Voice Messages

When a voice message arrives from Telegram or WhatsApp:
1. Audio is transcribed (STT provider)
2. Transcription sent to the AI
3. Response optionally converted to audio (TTS provider)
4. Audio response sent back to the channel

Configure voice mode in Settings > Voice.
