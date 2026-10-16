// Speech-to-text providers. The app sends only 16 kHz mono speech audio, never
// the video, and only to the provider the user picks with their own key.
import { normalizeTranscript } from "./edit-core.js";

export const PROVIDERS = {
  groq: {
    label: "Groq Whisper",
    note: "Fast and inexpensive, with a free tier. Key from console.groq.com/keys.",
    keyUrl: "https://console.groq.com/keys",
  },
  openai: {
    label: "OpenAI Whisper",
    note: "Uses whisper-1 with word timestamps. Key from platform.openai.com/api-keys.",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  elevenlabs: {
    label: "ElevenLabs Scribe",
    note: "The kit's default provider. Key from elevenlabs.io/app/settings/api-keys.",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
};

const MAX_UPLOAD = 24 * 1024 * 1024;

async function whisperCompatible(url, model, { wav, key, language, prompt, signal }) {
  const form = new FormData();
  form.append("file", wav, "speech.wav");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal });
  return readResponse(res);
}

async function elevenlabs({ wav, key, language, signal }) {
  const form = new FormData();
  form.append("file", wav, "speech.wav");
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  if (language) form.append("language_code", language);
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form, signal });
  return readResponse(res);
}

async function readResponse(res) {
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      message = j.error?.message ?? j.detail?.message ?? j.detail ?? j.message ?? message;
    } catch {
      // keep raw text
    }
    if (res.status === 401) message = "The API key was rejected. Check it in Settings.";
    if (res.status === 413) message = "The audio is too large for this provider. Trim the clip first.";
    throw new Error(`Transcription failed (${res.status}): ${typeof message === "string" ? message : JSON.stringify(message)}`);
  }
  return JSON.parse(text);
}

export async function transcribe(provider, opts) {
  if (!opts.key) throw new Error(`Add your ${PROVIDERS[provider]?.label ?? provider} API key in Settings first.`);
  if (opts.wav.size > MAX_UPLOAD) throw new Error("This clip is over ~12 minutes of speech; trim it before transcribing.");
  let raw;
  if (provider === "groq") raw = await whisperCompatible("https://api.groq.com/openai/v1/audio/transcriptions", "whisper-large-v3-turbo", opts);
  else if (provider === "openai") raw = await whisperCompatible("https://api.openai.com/v1/audio/transcriptions", "whisper-1", opts);
  else if (provider === "elevenlabs") raw = await elevenlabs(opts);
  else throw new Error(`Unknown provider: ${provider}`);
  const t = normalizeTranscript(raw);
  return { ...t, provider };
}
