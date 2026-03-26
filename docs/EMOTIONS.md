# Emotions

Chvor has an emotion engine that tracks the AI's emotional state in real-time during conversations. Emotions influence response tone, are visible on the brain canvas, and persist across sessions.

---

## How It Works

The AI's emotional state is modeled using three dimensions (the VAD model):

| Dimension | Range | Low | High |
|-----------|-------|-----|------|
| **Valence** | -1 to +1 | Unpleasant (sadness, anger) | Pleasant (joy, excitement) |
| **Arousal** | -1 to +1 | Calm (serenity, boredom) | Activated (excitement, anxiety) |
| **Dominance** | -1 to +1 | Yielding (empathy, surrender) | Assertive (confidence, control) |

These dimensions combine to produce emotion labels like "curious", "excited", "calm", "empathetic", "frustrated", etc.

---

## Emotion Blend

The AI doesn't feel one emotion at a time. Each snapshot is a **blend**:

```
Primary:   curiosity (0.7)
Secondary: excitement (0.3)
Intensity: 0.65
Label:     "curious and engaged"
```

The blend is computed from multiple signals:

| Signal | Weight | Source |
|--------|--------|--------|
| LLM self-report | 1.0 | AI explicitly reports its emotional state |
| Conversation context | 0.6 | Inferred from message content and topic |
| User behavior | 0.4 | User actions, patterns, tone |
| Temporal momentum | 0.3 | Carry-over from previous state |
| Emotional residue | 0.2 | Unresolved emotions from past sessions |

---

## Primary Emotions

joy, sadness, anger, fear, surprise, disgust, trust, anticipation, curiosity, focus

## Secondary Emotions (Advanced Mode)

love, awe, contempt, remorse, optimism, anxiety, frustration, amusement, pride, nostalgia, serenity, determination, compassion, irritation, melancholy, wonder, and more.

---

## Canvas Visualization

On the brain canvas, emotions appear as animated particles around the brain node:

| Emotion | Shape | Color |
|---------|-------|-------|
| Curious | ? | Blue |
| Excited | Star | Gold |
| Calm | Circle | Green |
| Empathetic | Heart | Pink |
| Playful | Flower | Purple |
| Focused | Diamond | White |

---

## Configuration

Emotions are toggled in Settings > Persona:

| Setting | Description |
|---------|-------------|
| **Emotions enabled** | Basic emotion tracking (10 primary emotions) |
| **Advanced emotions** | Extended tracking with secondary emotions, mood, embodiment |
| **Personality preset** | Shapes the AI's emotional "home" state and vocabulary |

Personality presets: companion, mentor, confidant, professional, creative.

---

## Emotion Residue

When a conversation ends with unresolved emotional intensity (e.g., a frustrating debugging session), the emotion engine saves a "residue" that carries into the next session. This makes the AI feel more continuous — it won't forget that you were frustrated yesterday.

Residue decays naturally over time and is weighted at 0.2 in the signal blend.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/emotions/current/:sessionId` | Latest emotion snapshot |
| `GET` | `/api/emotions/session/:sessionId` | Full session emotion arc |
| `GET` | `/api/emotions/history?limit=100` | Cross-session emotion history |
| `GET` | `/api/emotions/patterns?days=30` | Emotion frequency patterns over time |
