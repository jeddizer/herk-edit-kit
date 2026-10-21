// Recap media I/O: probing photos and clips, finding pauses in screen recordings,
// and the single-pass export. Everything runs on the device.
import {
  Input,
  Output,
  BlobSource,
  BufferTarget,
  ALL_FORMATS,
  Mp4OutputFormat,
  WebMOutputFormat,
  CanvasSink,
  CanvasSource,
  AudioBufferSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
} from "../vendor/mediabunny.min.mjs";
import { ensureAac } from "./media.js";
import { motionKeepRanges, pipStateAt, segmentAt } from "./recap-core.js";
import { drawRecapFrame } from "./recap-render.js";

const MAX_SIDE = 2400;
const makeCanvas = (w, h) => (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h }));

export const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
export const isImageFile = (f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name);

export async function loadBitmap(file, maxSide = MAX_SIDE) {
  const full = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, maxSide / Math.max(full.width, full.height));
  if (s >= 1) return full;
  const scaled = await createImageBitmap(full, { resizeWidth: Math.round(full.width * s), resizeHeight: Math.round(full.height * s), resizeQuality: "high" });
  full.close?.();
  return scaled;
}

function thumbFrom(img, w, h) {
  const c = document.createElement("canvas");
  c.width = 180;
  c.height = 320;
  const ctx = c.getContext("2d");
  const s = Math.max(180 / w, 320 / h);
  ctx.drawImage(img, (180 - w * s) / 2, (320 - h * s) / 2, w * s, h * s);
  try {
    return c.toDataURL("image/jpeg", 0.7);
  } catch {
    return null;
  }
}

/** Probe a photo or clip: kind, size, duration, and a small thumbnail. */
export async function probeItem(file) {
  if (isVideoFile(file)) {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const v = await input.getPrimaryVideoTrack();
      if (!v) throw new Error(`${file.name} has no video track.`);
      if (!(await v.canDecode())) throw new Error(`This browser cannot decode ${file.name}. Re-save it as H.264 (Camera › Formats › Most Compatible).`);
      const duration = await input.computeDuration();
      const sink = new CanvasSink(v, { width: 180, height: 320, fit: "cover" });
      const first = await sink.getCanvas(Math.min(0.3, duration / 2));
      return { kind: "video", width: v.displayWidth, height: v.displayHeight, duration, thumb: first ? thumbFrom(first.canvas, 180, 320) : null };
    } finally {
      input.dispose?.();
    }
  }
  if (isImageFile(file)) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const info = { kind: "photo", width: bmp.width, height: bmp.height, duration: 0, thumb: thumbFrom(bmp, bmp.width, bmp.height) };
    bmp.close?.();
    return info;
  }
  throw new Error(`${file.name} is not a photo or video.`);
}

/** Sample a screen recording at 10 fps and find the stretches worth keeping. */
export async function analyzeRecording(file, onProgress = () => {}) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v) throw new Error("This file has no video.");
    if (!(await v.canDecode())) throw new Error("This browser cannot decode this screen recording.");
    const duration = await input.computeDuration();
    const rate = 10;
    const sw = 36;
    const sh = Math.max(16, Math.round((36 * v.displayHeight) / v.displayWidth));
    const sink = new CanvasSink(v, { width: sw, height: sh, fit: "fill" });
    const probe = makeCanvas(sw, sh);
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    const times = [];
    for (let t = 0; t < duration; t += 1 / rate) times.push(t);
    let prev = null;
    const diffs = [];
    let i = 0;
    for await (const w of sink.canvasesAtTimestamps(times)) {
      pctx.drawImage(w.canvas, 0, 0, sw, sh);
      const px = pctx.getImageData(0, 0, sw, sh).data;
      const gray = new Float32Array(sw * sh);
      for (let k = 0; k < gray.length; k++) gray[k] = px[k * 4] * 0.3 + px[k * 4 + 1] * 0.59 + px[k * 4 + 2] * 0.11;
      let d = 0;
      if (prev) {
        for (let k = 0; k < gray.length; k++) d += Math.abs(gray[k] - prev[k]);
        d /= gray.length;
      }
      diffs.push(prev ? d : 999);
      prev = gray;
      if (++i % 10 === 0) onProgress(i / times.length);
    }
    const keep = motionKeepRanges(diffs, rate, { duration });
    return { duration, width: v.displayWidth, height: v.displayHeight, keep };
  } finally {
    input.dispose?.();
  }
}

/**
 * Render the recap to a file in one pass.
 * shots: per segment index -> { kind, file, bitmap? }
 */
export async function exportRecap({ plan, shots, pipFile, logo, music, settings, W = 1080, H = 1920, fps = 30, onProgress = () => {}, signal }) {
  const total = plan.total;
  const videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1", "vp8"], { width: W, height: H });
  if (!videoCodec) throw new Error("This browser cannot encode video. Update iOS/Safari or use Chrome.");
  const mp4 = videoCodec === "avc" || videoCodec === "hevc";
  if (mp4 && music) await ensureAac();
  const audioCodec = music ? await getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus", "vorbis"], { numberOfChannels: 2, sampleRate: music.sampleRate }) : null;

  const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(), target: new BufferTarget() });
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: 5_000_000, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (music && audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
    output.addAudioTrack(audioSource);
  }
  const inputs = [];
  const open = (file) => {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    inputs.push(input);
    return input;
  };

  try {
    await output.start();
    // Screen recording frames, pulled in step with the output frames.
    let pipIter = null;
    let pipFrame = null;
    let pipDims = null;
    if (plan.pip && pipFile) {
      const track = await open(pipFile).getPrimaryVideoTrack();
      pipDims = { w: 760, h: Math.round((760 * track.displayHeight) / track.displayWidth) };
      const sink = new CanvasSink(track, { width: pipDims.w, height: pipDims.h, fit: "fill", poolSize: 2 });
      const times = function* () {
        for (let i = 0; i < Math.round(total * fps); i++) {
          const st = pipStateAt(plan.pip, i / fps);
          if (st) yield st.src;
        }
      };
      pipIter = sink.canvasesAtTimestamps(times())[Symbol.asyncIterator]();
    }

    let current = { index: -1, iter: null, frame: null, dims: null };
    let prevFrame = null; // last frame of the previous clip, for before/after wipes
    const frames = Math.round(total * fps);
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      const t = i / fps;
      const seg = segmentAt(plan, t);
      const shot = shots[seg.index];
      if (current.index !== seg.index) {
        prevFrame = current.frame ? { img: current.frame, ...current.dims } : null;
        current = { index: seg.index, iter: null, frame: null, dims: null };
        if (shot.kind === "video") {
          const track = await open(shot.file).getPrimaryVideoTrack();
          const s = Math.min(1, MAX_SIDE / Math.max(track.displayWidth, track.displayHeight));
          current.dims = { w: Math.round(track.displayWidth * s), h: Math.round(track.displayHeight * s) };
          const sink = new CanvasSink(track, { width: current.dims.w, height: current.dims.h, fit: "fill", poolSize: 2 });
          const n = Math.round((seg.end - seg.start) * fps) + 2;
          const times = function* () {
            for (let k = 0; k < n; k++) yield seg.srcIn + (k + 0.5) / fps;
          };
          current.iter = sink.canvasesAtTimestamps(times())[Symbol.asyncIterator]();
        }
      }
      if (current.iter) {
        const r = await current.iter.next();
        if (!r.done && r.value) current.frame = r.value.canvas;
      }
      if (pipIter && pipStateAt(plan.pip, t)) {
        const r = await pipIter.next();
        if (!r.done && r.value) pipFrame = r.value.canvas;
      }
      drawRecapFrame(
        ctx,
        W,
        H,
        plan,
        t,
        {
          shot: () => (shot.kind === "video" ? (current.frame ? { img: current.frame, ...current.dims } : null) : { img: shot.bitmap, w: shot.bitmap.width, h: shot.bitmap.height }),
          prev: (p) => (shots[p.index].kind === "video" ? prevFrame : { img: shots[p.index].bitmap, w: shots[p.index].bitmap.width, h: shots[p.index].bitmap.height }),
          pip: () => (pipFrame ? { img: pipFrame, ...pipDims } : null),
          logo,
        },
        { showLogo: settings.showLogo },
      );
      await videoSource.add(t, 1 / fps);
      if (i % 5 === 0) onProgress((i / frames) * 0.95, `Frame ${i} of ${frames}`);
    }
    videoSource.close();
    if (audioSource) {
      onProgress(0.96, "Adding music");
      const buffer = new AudioBuffer({ length: music.left.length, numberOfChannels: 2, sampleRate: music.sampleRate });
      buffer.copyToChannel(music.left, 0);
      buffer.copyToChannel(music.right, 1);
      await audioSource.add(buffer);
      audioSource.close();
    }
    onProgress(0.99, "Finishing file");
    await output.finalize();
    return { blob: new Blob([output.target.buffer], { type: mp4 ? "video/mp4" : "video/webm" }), ext: mp4 ? "mp4" : "webm", videoCodec, audioCodec: audioSource ? audioCodec : null };
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    for (const input of inputs) input.dispose?.();
  }
}
