// apps/server/src/lib/voice/voice-middleware.ts
import type { NormalizedMessage, ChannelType } from "@chvor/shared";
import { getConfig } from "../../db/config-store.ts";
import { getSTTProvider } from "./stt-provider.ts";
import { synthesizeWithFallback } from "./tts-chain.ts";
import type { AudioFormat } from "../../channels/channel.ts";
import { saveAudio, audioUrl } from "./audio-store.ts";
import { createModelForRole } from "../llm-router.ts";
import { generateText } from "ai";

export type TtsMode = "off" | "always" | "inbound";

export interface VoicePostResult {
  text: string;
  audio?: { data: Uint8Array; format: AudioFormat };
  audioUrl?: string;
  duration?: number;
}

/**
 * Pre-process: if message has audioData, transcribe it via Whisper STT.
 * Sets msg.text and msg.inputModality.
 */
export async function preProcess(msg: NormalizedMessage): Promise<NormalizedMessage> {
  if (!msg.audioData || msg.audioData.length === 0) {
    return msg; // Text message — pass through
  }

  try {
    const provider = getSTTProvider();
    const OGG_CHANNELS: string[] = ["telegram", "whatsapp"];
    const format = OGG_CHANNELS.includes(msg.channelType) ? "ogg" : "webm";
    const result = await provider.transcribe(msg.audioData, format);
    if (process.env.VOICE_DEBUG) {
      console.log(`[voice] STT transcribed: "${result.text.slice(0, 80)}..."`);
    }
    // Return a new object — don't mutate the input
    return { ...msg, inputModality: "voice", text: result.text, audioData: undefined };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[voice] STT failed:", errMsg);
    throw new Error(`Voice transcription failed: ${errMsg}`);
  }
}

/**
 * Post-process: optionally synthesize TTS audio for the response.
 * Returns the text + optional audio attachment and URL.
 */
export async function postProcess(
  text: string,
  ctx: { ttsMode: TtsMode; inputModality: "text" | "voice"; channelType: ChannelType }
): Promise<VoicePostResult> {
  const shouldSynthesize =
    ctx.ttsMode === "always" ||
    (ctx.ttsMode === "inbound" && ctx.inputModality === "voice");

  if (!shouldSynthesize || !text.trim()) {
    return { text };
  }

  try {
    const maxLength = parseInt(getConfig("voice.tts.maxLength") ?? "1500", 10);
    let ttsText = text;
    if (ttsText.length > maxLength) {
      ttsText = await summarizeForTTS(ttsText);
    }

    ttsText = stripMarkdown(ttsText);

    const voice = getConfig("voice.tts.voice") ?? undefined;
    const speed = parseFloat(getConfig("voice.tts.speed") ?? "1.0") || 1.0;
    const result = await synthesizeWithFallback(ttsText, ctx.channelType, voice, speed);

    const ext = result.format === "ogg" ? "ogg" : result.format === "wav" ? "wav" : "mp3";
    const id = await saveAudio(result.audio, ext);
    const url = audioUrl(id, ext);

    return {
      text,
      audio: { data: result.audio, format: result.format },
      audioUrl: url,
      duration: result.duration,
    };
  } catch (err) {
    console.error("[voice] TTS failed:", err instanceof Error ? err.message : err);
    return { text };
  }
}

/** Get current TTS mode from config. */
export function getTtsMode(): TtsMode {
  return (getConfig("voice.tts.mode") as TtsMode) ?? "inbound";
}

/** Check if TTS will be active for a given input modality. */
export function willTtsBeActive(inputModality: "text" | "voice"): boolean {
  const mode = getTtsMode();
  return mode === "always" || (mode === "inbound" && inputModality === "voice");
}

/** Summarize long text for TTS using the lightweight model. */
async function summarizeForTTS(text: string): Promise<string> {
  try {
    const model = createModelForRole("lightweight");
    const result = await generateText({
      model,
      messages: [
        {
          role: "system",
          content: "Summarize the following text into a concise spoken version (under 200 words). Keep the key information. Do not use markdown, bullet points, or formatting. Write in natural conversational prose.",
        },
        { role: "user", content: text },
      ],
      maxTokens: 500,
    });
    return result.text || text.slice(0, 1500);
  } catch (err) {
    console.warn("[voice] summarization failed, truncating:", err);
    return text.slice(0, 1500);
  }
}

/** Strip markdown formatting for cleaner TTS output. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " [code block] ")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s/gm, "")
    .replace(/^\d+\.\s/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
