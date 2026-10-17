// Media I/O on the device: probing, speech audio extraction for transcription,
// and the frame-accurate MP4 export. Nothing here uploads anything.
import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  ALL_FORMATS,
  Mp4OutputFormat,
  WebMOutputFormat,
  CanvasSink,
  AudioBufferSink,
  CanvasSource,
  AudioBufferSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  canEncodeAudio,
} from "../vendor/mediabunny.min.mjs";
import { drawFrame, FORMATS } from "./render.js";
import { timelineDuration, srcAt, ENVELOPE_HOP } from "./edit-core.js";

const SPEECH_RATE = 16000;

export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video) throw new Error("This file has no video track.");
    const duration = await input.computeDuration();
    const stats = await video.computePacketStats(90).catch(() => null);
    return {
      duration,
      width: video.displayWidth,
      height: video.displayHeight,
      fps: stats?.averagePacketRate ? Math.round(stats.averagePacketRate) : 30,
      hasAudio: !!audio,
      canDecodeVideo: await video.canDecode(),
      canDecodeAudio: audio ? await audio.canDecode() : false,
    };
  } finally {
    input.dispose?.();
  }
}

// Decode the audio track to 16 kHz mono (what speech models expect) and an RMS
// envelope in dB for waveform display and silence detection.
export async function extractSpeech(file, onProgress = () => {}) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode())) throw new Error("This browser cannot decode the clip's audio.");
    const duration = await input.computeDuration();
    const rate = track.sampleRate;
    const mono = new Float32Array(Math.ceil(duration * rate) + rate);
    const sink = new AudioBufferSink(track);
    let written = 0;
    for await (const { buffer, timestamp } of sink.buffers()) {
      const offset = Math.max(0, Math.round(timestamp * rate));
      const chans = buffer.numberOfChannels;
      const data = [];
      for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));
      const len = Math.min(buffer.length, mono.length - offset);
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (let c = 0; c < chans; c++) v += data[c][i];
        mono[offset + i] = v / chans;
      }
      written = Math.max(written, offset + len);
      onProgress(Math.min(1, timestamp / duration));
    }
    const pcm = await resample(mono.subarray(0, written), rate, SPEECH_RATE);
    return { pcm, rate: SPEECH_RATE, duration: written / rate, envelope: envelopeDb(pcm, SPEECH_RATE) };
  } finally {
    input.dispose?.();
  }
}

async function resample(samples, from, to) {
  if (from === to) return samples;
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const length = Math.ceil((samples.length * to) / from);
  if (Ctx) {
    try {
      const ctx = new Ctx(1, length, to);
      const buf = ctx.createBuffer(1, samples.length, from);
      buf.copyToChannel(samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      node.start();
      const rendered = await ctx.startRendering();
      return rendered.getChannelData(0);
    } catch {
      // fall through to linear interpolation
    }
  }
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = (samples[k] ?? 0) * (1 - f) + (samples[k + 1] ?? 0) * f;
  }
  return out;
}

export function envelopeDb(pcm, rate) {
  const hop = Math.round(rate * ENVELOPE_HOP);
  const n = Math.floor(pcm.length / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) sum += pcm[k] * pcm[k];
    env[i] = Math.max(-90, 10 * Math.log10(sum / hop + 1e-12));
  }
  return env;
}

export function encodeWav(pcm, rate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Export: one pass, frame-accurate. Each output frame maps to an exact source
// time and audio is sliced sample-accurately from the same keep ranges, so lip
// sync cannot drift at the joins.
export async function exportStory({ file, model, timeline, fps = 30, onProgress = () => {}, signal }) {
  const { w: W, h: H } = FORMATS[model.settings.format];
  const total = timelineDuration(timeline);
  if (!total) throw new Error("Nothing to export: every part of the clip is cut.");

  const videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1", "vp8"], { width: W, height: H });
  if (!videoCodec) throw new Error("This browser cannot encode video. Update iOS/Safari or use Chrome.");
  const mp4 = videoCodec === "avc" || videoCodec === "hevc";
  if (mp4) await ensureAac();
  const audioCodec = await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus", "vorbis"], { numberOfChannels: 2, sampleRate: 48000 });

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({
    format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  try {
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack();
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = canvas.getContext("2d", { alpha: false });

    const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: 5_000_000, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: fps });
    let audioSource = null;
    if (aTrack && audioCodec && (await aTrack.canDecode())) {
      audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    // Limit decode size: enough resolution for a 2x punch-in on 1080 wide.
    const sw = vTrack.displayWidth;
    const sh = vTrack.displayHeight;
    const scale = Math.min(1, 2400 / Math.max(sw, sh));
    const sink = new CanvasSink(vTrack, { width: Math.round(sw * scale), height: Math.round(sh * scale), fit: "fill", poolSize: 2 });

    const frames = Math.max(1, Math.round(total * fps));
    const audioShare = audioSource ? 0.15 : 0;
    function* times() {
      for (let i = 0; i < frames; i++) yield srcAt(timeline, (i + 0.5) / fps);
    }
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(times())) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      const t = i / fps;
      drawFrame(ctx, W, H, wrapped?.canvas ?? null, wrapped?.canvas.width, wrapped?.canvas.height, t, model, false);
      await videoSource.add(t, 1 / fps);
      i++;
      if (i % 5 === 0) onProgress((i / frames) * (1 - audioShare), `Frame ${i} of ${frames}`);
    }
    videoSource.close();

    if (audioSource) {
      onProgress(1 - audioShare, "Mixing audio");
      const buffer = await sliceAudio(aTrack, timeline, frames / fps, signal);
      await audioSource.add(buffer);
      audioSource.close();
    }

    onProgress(0.99, "Finishing file");
    await output.finalize();
    const type = mp4 ? "video/mp4" : "video/webm";
    return { blob: new Blob([output.target.buffer], { type }), ext: mp4 ? "mp4" : "webm", videoCodec, audioCodec: audioSource ? audioCodec : null };
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    input.dispose?.();
  }
}

// Some browsers (older Safari) cannot encode AAC natively. Load a WASM AAC
// encoder only then, so MP4 exports always carry audio social apps accept.
let aacReady = null;
export function ensureAac() {
  aacReady ??= (async () => {
    if (await canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48000 })) return;
    const { registerAacEncoder } = await import("../vendor/mediabunny-aac-encoder.min.mjs");
    registerAacEncoder();
  })().catch((err) => console.warn("AAC fallback unavailable", err));
  return aacReady;
}

// Copy each kept range of the source audio into one buffer with 5 ms fades at
// every join so cuts never click.
async function sliceAudio(track, timeline, length, signal) {
  const rate = track.sampleRate;
  const channels = Math.min(2, track.numberOfChannels);
  const total = Math.round(length * rate);
  const out = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(total));
  const sink = new AudioBufferSink(track);
  const fade = Math.round(rate * 0.005);

  for (const seg of timeline) {
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    const segStart = Math.round(seg.outStart * rate);
    const segLen = Math.min(total - segStart, Math.round((seg.end - seg.start) * rate));
    if (segLen <= 0) continue;
    for await (const { buffer, timestamp } of sink.buffers(seg.start, seg.end)) {
      const srcOffset = Math.round((timestamp - seg.start) * rate);
      const nch = buffer.numberOfChannels;
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(Math.min(c, nch - 1));
        for (let k = 0; k < buffer.length; k++) {
          const pos = srcOffset + k;
          if (pos < 0 || pos >= segLen) continue;
          out[c][segStart + pos] = data[k];
        }
      }
    }
    for (let c = 0; c < channels; c++) {
      const d = out[c];
      for (let k = 0; k < fade && k < segLen; k++) {
        const g = k / fade;
        d[segStart + k] *= g;
        d[segStart + segLen - 1 - k] *= g;
      }
    }
  }
  const buffer = new AudioBuffer({ length: total, numberOfChannels: channels, sampleRate: rate });
  out.forEach((d, c) => buffer.copyToChannel(d, c));
  return buffer;
}
