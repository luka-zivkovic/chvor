# Voice

Chvor supports voice input (speech-to-text) and voice output (text-to-speech) across all channels. Talk to the AI with your voice in the web chat, or send voice messages via Telegram and WhatsApp.

---

## Quick Start

1. Go to Settings > Voice
2. Pick a TTS provider (Edge TTS is free, no API key needed)
3. Pick a STT provider (browser is built-in, Whisper for better accuracy)
4. Set TTS mode to "Always" to hear every response

---

## Speech-to-Text (STT)

| Provider | Cost | Privacy | Quality | Setup |
|----------|------|---------|---------|-------|
| **Browser** | Free | Local | Medium | Built-in (Web Speech API) |
| **Whisper API** | ~$0.006/min | Cloud | High | Requires OpenAI API key |
| **Whisper Local** | Free | Local | High | ~40MB model download |

### Supported Audio Formats

webm, ogg, wav, mp3, oga, m4a (max 10MB)

### Transcription API

```bash
curl -X POST http://localhost:3001/api/voice/transcribe \
  -F "audio=@recording.webm"
```

---

## Text-to-Speech (TTS)

| Provider | Cost | Privacy | Quality | Voices |
|----------|------|---------|---------|--------|
| **Edge TTS** | Free | Cloud (Microsoft) | Good | 300+ voices, many languages |
| **OpenAI TTS** | ~$0.015/1K chars | Cloud | High | alloy, echo, fable, onyx, nova, shimmer |
| **ElevenLabs** | Freemium | Cloud | Highest | 30+ natural voices |
| **Piper** | Free | Local | Good | ~30MB model download |

### TTS Modes

| Mode | Behavior |
|------|----------|
| `off` | No audio responses |
| `always` | Every response generates audio |
| `inbound` | Only respond with audio when the user sends a voice message |

---

## Configuration

```bash
# Get current voice config
curl http://localhost:3001/api/voice/config

# Update
curl -X PUT http://localhost:3001/api/voice/config \
  -H 'Content-Type: application/json' \
  -d '{
    "tts": { "provider": "edge", "voice": "en-US-AriaNeural", "mode": "always" },
    "stt": { "provider": "whisper-local" }
  }'
```

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tts.provider` | — | TTS provider (openai, elevenlabs, edge, piper) |
| `tts.voice` | — | Voice ID (provider-specific) |
| `tts.mode` | `off` | When to generate audio (off, always, inbound) |
| `tts.maxLength` | 1500 | Max characters to synthesize per response |
| `stt.provider` | `browser` | STT provider (browser, whisper-api, whisper-local) |

---

## Local Models

Download and manage local ML models (no API key needed, fully private):

```bash
# List available models
curl http://localhost:3001/api/voice/models

# Download a model
curl -X POST http://localhost:3001/api/voice/models/whisper-base/download

# Check download progress
curl http://localhost:3001/api/voice/models/whisper-base/status

# Delete a model
curl -X DELETE http://localhost:3001/api/voice/models/whisper-base
```

---

## Channel-Specific Behavior

| Channel | Audio Format | Voice Input | Voice Output |
|---------|-------------|-------------|--------------|
| Web Chat | mp3 | Via browser microphone | Inline audio player |
| Telegram | ogg (Opus) | Voice messages | Voice message reply |
| WhatsApp | ogg (Opus) | Voice messages | Voice message reply |
| Discord | — | Not supported | Not supported |
| Slack | — | Not supported | Not supported |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/voice/transcribe` | Convert audio to text (multipart, 10MB limit) |
| `GET` | `/api/voice/status` | Provider availability |
| `GET` | `/api/voice/config` | Current voice settings |
| `PUT` | `/api/voice/config` | Update voice settings |
| `GET` | `/api/voice/models` | List models with download status |
| `POST` | `/api/voice/models/:id/download` | Start model download |
| `GET` | `/api/voice/models/:id/status` | Check download progress |
| `DELETE` | `/api/voice/models/:id` | Remove downloaded model |
