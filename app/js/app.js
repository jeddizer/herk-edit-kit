// Story Studio: UI controller. Edits are non-destructive; the source clip is
// stored untouched and every export renders fresh from it.
import {
  silenceCuts,
  longSilenceCuts,
  findMistakes,
  wordCutRange,
  keepRanges,
  buildTimeline,
  timelineDuration,
  srcAt,
  outAt,
  segmentIndexAt,
  retimeWords,
  chunkCaptions,
  computeShots,
  storyChecks,
  fitToLimit,
  speechRegionsFromEnvelope,
  refineWordTimings,
  normalizeTranscript,
  ENVELOPE_HOP,
  toSrt,
  kitBundle,
} from "./edit-core.js";
import { drawFrame, loadFonts, FORMATS, DEFAULT_SETTINGS } from "./render.js";
import { PROVIDERS, transcribe } from "./transcribe.js";
import * as store from "./store.js";
import { createRecapEditor } from "./recap-app.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

const state = {
  project: null,
  file: null,
  url: null,
  speech: null, // { pcm, rate } in memory only
  d: null, // derived edit
  playing: false,
  outT: 0,
  bypass: null, // { end } while auditioning the original
  dirty: true,
  prefs: store.loadPrefs(),
  wordIndex: null,
  exportResult: null,
  exportAbort: null,
  installEvent: null,
};

const video = $("#source");
const preview = $("#preview");
const pctx = preview.getContext("2d");
const timelineCanvas = $("#timeline");

// Mediabunny is loaded lazily so the home screen opens instantly.
let mediaModule = null;
const media = () => (mediaModule ??= import("./media.js"));

// ---------------------------------------------------------------------------
// Feedback
let toastTimer = 0;
function toast(msg, error = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 6000 : 2600);
}
function busy(text) {
  $("#busy").hidden = !text;
  if (text) $("#busy-text").textContent = text;
}

// ---------------------------------------------------------------------------
// Derivation: everything shown or exported comes from the project + this.
function derive() {
  const p = state.project;
  const s = p.settings;
  const duration = p.media.duration;
  const words = refineWordTimings(p.transcript?.words ?? [], p.envelope, ENVELOPE_HOP);
  const basis = words.length ? words : p.speech ?? [];
  const silence = silenceCuts(basis, duration, s.pace);
  if (words.length && p.speech) silence.push(...longSilenceCuts(p.speech, s.pace));
  const mistakes = words.length ? findMistakes(words) : [];
  for (const m of mistakes) m.enabled = p.decisions[m.id] ?? m.recommend;
  const wordCuts = Object.entries(p.wordEdits)
    .filter(([i, e]) => e.cut && words[i])
    .map(([i]) => ({ kind: "word", ...wordCutRange(words, Number(i)), note: `Removed “${words[i].text}”` }));
  const cuts = [...silence, ...mistakes.filter((m) => m.enabled), ...wordCuts];
  if (p.trimEnd != null && p.trimEnd < duration) cuts.push({ kind: "trim", start: p.trimEnd, end: duration, note: "Ending trimmed to fit the length limit" });
  const timeline = buildTimeline(keepRanges(cuts, duration));
  const outWords = retimeWords(words, timeline, p.wordEdits);
  const captions = chunkCaptions(outWords, { maxWords: s.captionStyle === "word" ? 1 : s.captionWords, maxChars: s.captionStyle === "word" ? 30 : 18 });
  const shots = computeShots(timeline, outWords, s.punchMode, { punch: s.punchZoom });
  const coach = storyChecks({ outWords, timeline, captionsOn: s.captions && outWords.length > 0, shots, captionY: s.captionY, format: s.format, hasTranscript: words.length > 0, limit: state.prefs.maxSeconds });
  state.d = { words, silence, mistakes, cuts, timeline, outWords, captions, shots, coach, total: timelineDuration(timeline) };
}

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveProject(state.project).catch((e) => toast(`Could not save: ${e.message}`, true)), 400);
}

function update({ panels = true } = {}) {
  derive();
  state.outT = Math.min(state.outT, state.d.total);
  if (panels) renderPanels();
  syncControls();
  renderTimeline();
  state.dirty = true;
  persist();
}

// ---------------------------------------------------------------------------
// Home
async function showHome() {
  stop();
  state.project = null;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
  state.file = null;
  state.speech = null;
  video.removeAttribute("src");
  video.load();
  $("#editor").hidden = true;
  if (recap?.active) recap.close();
  $("#recap").hidden = true;
  $("#home").hidden = false;
  const list = await store.listProjects().catch(() => []);
  $("#empty-projects").textContent = list.length ? "Your edits stay on this device." : "No stories yet. Your edits stay on this device.";
  $("#project-list").innerHTML = list
    .map(
      (p) => `<li class="project">
        <button class="open" data-action="open-project" data-id="${esc(p.id)}">
          ${p.thumb ? `<img class="thumb" src="${esc(p.thumb)}" alt="">` : `<div class="thumb"></div>`}
          <div class="meta"><strong>${esc(p.name)}</strong><span>${p.mode === "recap" ? `Recap · ${p.recap?.items?.length ?? 0} shots` : fmtTime(p.media?.duration ?? 0)} · ${new Date(p.updated).toLocaleDateString()}</span></div>
        </button>
        <button class="del" data-action="delete-project" data-id="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">×</button>
      </li>`,
    )
    .join("");
  updateInstallCard();
}

function updateInstallCard() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const card = $("#install-card");
  card.hidden = standalone;
  if (standalone) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  $("#install-btn").hidden = !state.installEvent;
  $("#install-text").textContent = ios
    ? "In Safari, tap Share, then Add to Home Screen. It opens full screen and works offline."
    : state.installEvent
      ? "Install it as an app: it opens full screen and works offline."
      : "Use your browser's menu to install this app or add it to your home screen.";
}

// ---------------------------------------------------------------------------
// Import
async function importFile(file) {
  if (!file) return;
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name)) return toast("Pick a video file.", true);
  $("#home").hidden = true;
  $("#editor").hidden = false;
  busy("Reading clip…");
  try {
    const m = await media();
    const info = await m.probe(file);
    if (!info.canDecodeVideo) throw new Error("This browser cannot decode this video. On Android or Windows, HEVC clips may need Chrome with hardware support; try exporting the clip as H.264.");
    const id = crypto.randomUUID?.() ?? String(Date.now());
    const project = {
      id,
      name: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Untitled story",
      created: Date.now(),
      media: { name: file.name, type: file.type, size: file.size, ...info },
      settings: { ...DEFAULT_SETTINGS },
      transcript: null,
      speech: null,
      envelope: null,
      decisions: {},
      wordEdits: {},
      thumb: null,
    };
    await store.saveMedia(id, file);
    store.requestPersistence();
    await openProject(project, file);
    await analyseAudio();
    if (state.prefs.keys?.[state.prefs.provider]) runTranscription();
    else toast("Silences trimmed from audio. Add an API key in Settings for word cuts and captions.");
  } catch (err) {
    console.error(err);
    busy(null);
    toast(err.message || String(err), true);
    showHome();
  }
}

async function analyseAudio() {
  const p = state.project;
  if (!p.media.hasAudio) return;
  if (!p.media.canDecodeAudio) return toast("This browser cannot decode the clip's audio.", true);
  busy("Listening for pauses…");
  const m = await media();
  const speech = await m.extractSpeech(state.file, (f) => busy(`Listening for pauses… ${Math.round(f * 100)}%`));
  busy(null);
  if (!speech) return;
  state.speech = speech;
  p.envelope = speech.envelope;
  p.speech = speechRegionsFromEnvelope(speech.envelope, ENVELOPE_HOP);
  update();
}

async function openProject(project, file) {
  state.project = project;
  state.file = file;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  video.src = state.url;
  state.outT = 0;
  $("#home").hidden = true;
  $("#editor").hidden = false;
  $("#project-name").value = project.name;
  setTab("cut");
  sizePreview();
  update();
  busy("Loading video…");
  await new Promise((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener("loadeddata", resolve, { once: true });
    video.addEventListener("error", resolve, { once: true });
  });
  busy(null);
  seekOut(0);
  if (!project.thumb) makeThumb();
}

function makeThumb() {
  const c = document.createElement("canvas");
  c.width = 180;
  c.height = 320;
  const draw = () => {
    drawFrame(c.getContext("2d"), 180, 320, video, video.videoWidth, video.videoHeight, state.outT, modelFor(), false);
    try {
      state.project.thumb = c.toDataURL("image/jpeg", 0.7);
      persist();
    } catch {
      // ignore tainted or unsupported canvases
    }
  };
  if (video.readyState >= 2) setTimeout(draw, 300);
}

async function loadProject(id) {
  busy("Opening…");
  try {
    const [project, file] = await Promise.all([store.getProject(id), store.getMedia(id)]);
    if (!project || !file) throw new Error("This project's clip is missing from storage.");
    project.settings = { ...DEFAULT_SETTINGS, ...project.settings };
    project.decisions ??= {};
    project.wordEdits ??= {};
    await openProject(project, file);
  } catch (err) {
    busy(null);
    toast(err.message, true);
    showHome();
  }
}

// ---------------------------------------------------------------------------
// Transcription
async function runTranscription() {
  const prefs = state.prefs;
  const key = prefs.keys?.[prefs.provider];
  if (!key) {
    openSettings();
    return toast(`Add your ${PROVIDERS[prefs.provider].label} key first.`);
  }
  try {
    const m = await media();
    if (!state.speech) {
      busy("Preparing audio…");
      state.speech = await m.extractSpeech(state.file);
      if (!state.speech) throw new Error("This clip has no audio to transcribe.");
    }
    busy(`Transcribing with ${PROVIDERS[prefs.provider].label}…`);
    const wav = m.encodeWav(state.speech.pcm, state.speech.rate);
    const t = await transcribe(prefs.provider, { wav, key, language: prefs.language.trim(), prompt: prefs.prompt.trim() });
    if (!t.words.length) throw new Error("No speech was recognised in this clip.");
    applyTranscript(t);
    toast(`Transcribed ${t.words.length} words.`);
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), true);
  } finally {
    busy(null);
  }
}

function applyTranscript(t) {
  const p = state.project;
  p.transcript = { words: t.words, language: t.language, provider: t.provider ?? "import" };
  p.decisions = {};
  p.wordEdits = {};
  update();
}

async function importTranscript(file) {
  try {
    const raw = JSON.parse(await file.text());
    const t = normalizeTranscript(raw);
    if (t.duration && Math.abs(t.duration - state.project.media.duration) > 1.5) toast("Heads up: this transcript's length differs from the clip. Use the transcript of this exact take.", true);
    applyTranscript({ ...t, provider: "import" });
    toast(`Imported ${t.words.length} words.`);
  } catch (err) {
    toast(`Could not import: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Panels
function renderPanels() {
  renderCutPanel();
  renderCoach();
}

function renderCutPanel() {
  const p = state.project;
  const d = state.d;
  const provider = PROVIDERS[state.prefs.provider];
  const hasKey = !!state.prefs.keys?.[state.prefs.provider];
  const status = $("#transcript-status");
  if (p.transcript) {
    status.innerHTML = `<div class="status-card">
      <p><strong>${p.transcript.words.length} words</strong> · ${esc(p.transcript.provider === "import" ? "imported transcript" : PROVIDERS[p.transcript.provider]?.label ?? p.transcript.provider)}</p>
      <div class="row"><button class="btn" data-action="transcribe">Transcribe again</button><button class="btn" data-action="import-transcript">Import JSON</button></div>
    </div>`;
  } else {
    status.innerHTML = `<div class="status-card">
      <p>${p.speech ? "Pauses are trimmed from the audio alone. " : ""}Transcribe for word-level cuts, retake detection, and captions.</p>
      <div class="row">
        <button class="btn primary" data-action="transcribe">${hasKey ? `Transcribe with ${esc(provider.label)}` : "Add API key"}</button>
        <button class="btn" data-action="import-transcript">Import JSON</button>
      </div>
    </div>`;
  }

  if (p.trimEnd != null) {
    status.insertAdjacentHTML("beforeend", `<div class="status-card"><p>Ending trimmed at ${fmtTime(p.trimEnd)} of the original to fit your ${state.prefs.maxSeconds || ""} s limit.</p><div class="row"><button class="btn" data-action="restore-ending">Restore ending</button></div></div>`);
  }

  const mistakes = d.mistakes;
  const label = { stutter: "Stutter", retake: "Retake", false_start: "False start", filler: "Filler" };
  $("#mistakes").innerHTML = mistakes.length
    ? `<p class="review-title"><span>Review possible mistakes</span><span class="muted">${mistakes.filter((m) => m.enabled).length} of ${mistakes.length} cut</span></p>
      <ul class="review">${mistakes
        .map(
          (m) => `<li class="${m.enabled ? "on" : ""}">
          <div class="head"><span class="kind">${label[m.kind]}</span><span class="muted">${fmtTime(m.start)} · ${(m.end - m.start).toFixed(1)} s · ${m.confidence}</span></div>
          <p class="txt"><s>${esc(m.removes)}</s>${m.keeps ? ` → <b>${esc(m.keeps)}</b>` : ""}</p>
          <p class="hint">${esc(m.note)}</p>
          <div class="actions">
            <button class="btn" data-action="audition" data-start="${m.start}" data-end="${m.end}">▶ Hear original</button>
            <button class="btn ${m.enabled ? "danger" : ""}" data-action="toggle-mistake" data-id="${esc(m.id)}">${m.enabled ? "Cut ✓" : "Keep ✓"}</button>
          </div>
        </li>`,
        )
        .join("")}</ul>`
    : p.transcript
      ? `<p class="hint">No stutters, retakes, or isolated fillers found.</p>`
      : "";

  const words = p.transcript?.words ?? [];
  if (!words.length) {
    $("#words").innerHTML = "";
    return;
  }
  const kept = new Set(d.outWords.map((w) => w.index));
  $("#words").innerHTML = `<p class="review-title"><span>Transcript</span><span class="muted">tap a word to edit</span></p>
    <div class="words">${words
      .map((w, i) => {
        const e = p.wordEdits[i] ?? {};
        const cls = [kept.has(i) ? "" : "cut", e.cut ? "manual" : "", e.color ? `c-${e.color}` : "", e.serif ? "serif" : ""].filter(Boolean).join(" ");
        return `<button data-word="${i}" class="${cls}">${esc(e.text ?? w.text)}</button>`;
      })
      .join(" ")}</div>`;
}

function renderCoach() {
  const { score, checks } = state.d.coach;
  const badge = $("#score-badge");
  badge.textContent = score;
  badge.className = `badge ${score >= 80 ? "good" : score >= 55 ? "warn" : "bad"}`;
  const fixes = {
    "pace-tight": "Use tight pace",
    "captions-on": "Turn captions on",
    "caption-y": "Move captions to the chest",
    "punch-phrases": "Punch in every phrase",
    hook: "Add a hook title",
    transcribe: "Transcribe",
    "fit-limit": "End at the last sentence that fits",
  };
  $("#coach").innerHTML = `<div class="score"><div class="ring" style="--p:${score}"><span>${score}</span></div>
      <div><strong>Story check</strong><p class="hint">Measured against the kit's house reel style. A high score cannot fix a weak raw take: script the hook before you record.</p></div></div>
    <ul class="checks">${checks
      .map(
        (c) => `<li class="${c.status}"><span class="dot"></span><div><strong>${esc(c.title)}</strong><p>${esc(c.detail)}</p>${
          c.fix && fixes[c.fix] && !(c.fix === "pace-tight" && state.project.settings.pace === "tight") ? `<button class="btn" data-action="fix" data-fix="${c.fix}">${fixes[c.fix]}</button>` : ""
        }</div></li>`,
      )
      .join("")}</ul>`;
}

function applyFix(fix) {
  const s = state.project.settings;
  if (fix === "pace-tight") s.pace = "tight";
  if (fix === "captions-on") s.captions = true;
  if (fix === "caption-y") s.captionY = 0.66;
  if (fix === "punch-phrases") s.punchMode = "phrases";
  if (fix === "transcribe") return runTranscription();
  if (fix === "fit-limit") {
    const end = fitToLimit(state.d.outWords, state.d.timeline, state.prefs.maxSeconds);
    if (end === null) return toast("No complete sentence fits inside the limit. Cut lines in the transcript instead.", true);
    state.project.trimEnd = srcAt(state.d.timeline, end);
    update();
    return toast(`Ending trimmed to ${fmtTime(end)}. Restore it from the Cut tab.`);
  }
  if (fix === "hook") {
    setTab("captions");
    $("#hook-input").focus();
    return;
  }
  update();
}

// Settings-bound controls: data-setting on inputs and segmented buttons.
function syncControls() {
  const s = state.project.settings;
  for (const el of $$("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.classList.contains("seg")) {
      for (const b of $$("button", el)) b.classList.toggle("active", String(s[key]) === b.dataset.value);
    } else if (el.type === "checkbox") el.checked = !!s[key];
    else if (document.activeElement !== el) el.value = s[key];
  }
  const fmt = {
    captionWords: (v) => `${v}`,
    captionSize: (v) => `${Math.round(v * 100)}%`,
    captionY: (v) => `${Math.round(v * 100)}%`,
    hookSeconds: (v) => `${v} s`,
    zoom: (v) => `${Number(v).toFixed(2)}×`,
    panX: (v) => `${Math.round(v * 100)}`,
    panY: (v) => `${Math.round(v * 100)}`,
    punchZoom: (v) => `${Number(v).toFixed(2)}×`,
    focusY: (v) => `${Math.round(v * 100)}%`,
  };
  for (const o of $$("output[data-out]")) o.textContent = fmt[o.dataset.out]?.(s[o.dataset.out]) ?? s[o.dataset.out];
  $("[data-setting=captionWords]").disabled = s.captionStyle === "word";
  const d = state.d;
  const src = state.project.media.duration;
  const limit = state.prefs.maxSeconds;
  const limitText = limit ? ` · ${d.total > limit ? "⚠ " : ""}limit ${limit} s` : "";
  $("#cut-summary").textContent = `${fmtTime(src)} → ${fmtTime(d.total)}${limitText} · ${(src - d.total).toFixed(1)} s removed in ${d.timeline.length > 0 ? d.timeline.length - 1 : 0} cuts · ${FORMATS[s.format].label}`;
  $("#cut-summary").classList.toggle("over", !!limit && d.total > limit);
  $("#scrub").max = Math.max(0.01, d.total).toFixed(2);
}

function onSettingInput(el, value) {
  const s = state.project.settings;
  const key = el.dataset.setting;
  const numeric = typeof DEFAULT_SETTINGS[key] === "number";
  s[key] = el.type === "checkbox" ? el.checked : numeric ? Number(value) : value;
  if (key === "format") sizePreview();
  // Sliders update without re-rendering lists so dragging stays smooth.
  update({ panels: ["pace", "captions", "captionStyle", "captionWords", "punchMode", "format", "captionY", "hookText"].includes(key) });
}

function setTab(name) {
  for (const t of $$(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tab-panel")) p.hidden = p.dataset.panel !== name;
}

// ---------------------------------------------------------------------------
// Preview playback
function modelFor() {
  return { settings: state.project.settings, captions: state.d.captions, shots: state.d.shots };
}

function sizePreview() {
  const f = FORMATS[state.project.settings.format];
  preview.width = f.w / 2;
  preview.height = f.h / 2;
  state.dirty = true;
}

function draw() {
  if (!state.project || !state.d) return;
  const ready = video.readyState >= 2 && video.videoWidth;
  const t = state.outT;
  drawFrame(pctx, preview.width, preview.height, ready ? video : null, video.videoWidth, video.videoHeight, t, modelFor(), true);
  $("#time").textContent = `${fmtTime(t)} / ${fmtTime(state.d.total)}`;
  if (document.activeElement !== $("#scrub")) $("#scrub").value = t.toFixed(2);
  renderPlayhead();
}

function tick() {
  requestAnimationFrame(tick);
  if (!state.project || $("#editor").hidden) return;
  if (state.playing) {
    const t = video.currentTime;
    if (state.bypass) {
      if (t >= state.bypass.end || video.ended) stop();
      state.outT = outAt(state.d.timeline, t) ?? state.outT;
    } else {
      const tl = state.d.timeline;
      const i = segmentIndexAt(tl, t + 0.015);
      if (i < 0 || video.ended) {
        stop();
        state.outT = 0;
        seekOut(0);
      } else if (t < tl[i].start - 0.02) {
        video.currentTime = tl[i].start; // jump over the cut
        state.outT = tl[i].outStart;
      } else state.outT = outAt(tl, t) ?? tl[i].outStart;
    }
    state.dirty = true;
  }
  if (state.dirty) {
    state.dirty = false;
    draw();
  }
}

function play() {
  if (!state.d?.total) return;
  if (state.outT >= state.d.total - 0.05) seekOut(0);
  state.bypass = null;
  video.play().then(
    () => {
      state.playing = true;
      $("#play-btn").classList.add("playing");
    },
    (err) => toast(`Playback blocked: ${err.message}`, true),
  );
}
function stop() {
  video.pause();
  state.playing = false;
  state.bypass = null;
  $("#play-btn")?.classList.remove("playing");
}
function seekOut(t) {
  state.outT = Math.max(0, Math.min(t, state.d?.total ?? 0));
  video.currentTime = srcAt(state.d.timeline, state.outT);
  state.dirty = true;
}
function audition(start, end) {
  stop();
  video.currentTime = Math.max(0, start - 1.2);
  state.bypass = { end: end + 0.8 };
  video.play().then(() => {
    state.playing = true;
    $("#play-btn").classList.add("playing");
  });
}
video.addEventListener("seeked", () => (state.dirty = true));
video.addEventListener("loadeddata", () => (state.dirty = true));

// Source timeline: waveform, kept vs cut, playhead.
function renderTimeline() {
  const c = timelineCanvas;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.round(56 * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d");
  const p = state.project;
  const dur = p.media.duration || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(242,85,85,0.22)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#232733";
  for (const seg of state.d.timeline) ctx.fillRect((seg.start / dur) * w, 0, ((seg.end - seg.start) / dur) * w, h);
  const env = p.envelope;
  if (env?.length) {
    ctx.fillStyle = "rgba(45,212,191,0.75)";
    const per = env.length / w;
    for (let x = 0; x < w; x++) {
      let peak = -90;
      for (let k = Math.floor(x * per); k < Math.floor((x + 1) * per); k++) peak = Math.max(peak, env[k]);
      const amp = Math.max(0, (peak + 60) / 60);
      const bh = Math.max(1, amp * h * 0.8);
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }
  const limit = state.prefs.maxSeconds;
  if (limit && state.d.total > limit) {
    const x = (srcAt(state.d.timeline, limit) / dur) * w;
    ctx.fillStyle = "#facc15";
    ctx.fillRect(Math.round(x) - 1, 0, 2 * dpr, h);
  }
  c._base = ctx.getImageData(0, 0, w, h);
  renderPlayhead();
}
function renderPlayhead() {
  const c = timelineCanvas;
  if (!c._base || !state.project) return;
  const ctx = c.getContext("2d");
  ctx.putImageData(c._base, 0, 0);
  const x = (video.currentTime / (state.project.media.duration || 1)) * c.width;
  ctx.fillStyle = "#fff";
  ctx.fillRect(Math.round(x) - 1, 0, 2, c.height);
}
function seekFromTimeline(ev) {
  const r = timelineCanvas.getBoundingClientRect();
  const s = ((ev.clientX - r.left) / r.width) * state.project.media.duration;
  const tl = state.d.timeline;
  const i = segmentIndexAt(tl, s);
  if (i < 0) return seekOut(state.d.total);
  seekOut(s < tl[i].start ? tl[i].outStart : outAt(tl, s));
}

// ---------------------------------------------------------------------------
// Word sheet
function openWord(i) {
  const p = state.project;
  const w = p.transcript.words[i];
  const e = p.wordEdits[i] ?? {};
  state.wordIndex = i;
  $("#word-text").value = e.text ?? w.text;
  $("#word-serif").checked = !!e.serif;
  for (const b of $$(".sw")) b.classList.toggle("active", (e.color ?? "") === b.dataset.color);
  $("#word-cut-btn").textContent = e.cut ? "Restore word" : "Cut word";
  $("#word-sheet").showModal();
}
function editWord(patch) {
  const p = state.project;
  const i = state.wordIndex;
  const next = { ...(p.wordEdits[i] ?? {}), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === false || next[k] === "") delete next[k];
  if (next.text === p.transcript.words[i].text) delete next.text;
  if (Object.keys(next).length) p.wordEdits[i] = next;
  else delete p.wordEdits[i];
  update();
}

// ---------------------------------------------------------------------------
// Settings sheet
function openSettings() {
  renderProviderSettings();
  $("#lang").value = state.prefs.language;
  $("#vocab").value = state.prefs.prompt;
  $("#max-seconds").value = String(state.prefs.maxSeconds);
  showLogoPreview();
  $("#settings").showModal();
}
function renderProviderSettings() {
  const prov = state.prefs.provider;
  for (const b of $$("#provider-seg button")) b.classList.toggle("active", b.dataset.provider === prov);
  $("#provider-note").innerHTML = `${esc(PROVIDERS[prov].note)} <a href="${PROVIDERS[prov].keyUrl}" target="_blank" rel="noopener">Get a key</a>`;
  $("#api-key").value = state.prefs.keys?.[prov] ?? "";
}
function saveSettings() {
  const prefs = state.prefs;
  prefs.keys = { ...prefs.keys, [prefs.provider]: $("#api-key").value.trim() };
  prefs.language = $("#lang").value.trim().toLowerCase();
  prefs.prompt = $("#vocab").value.trim();
  prefs.maxSeconds = Number($("#max-seconds").value);
  store.savePrefs(prefs);
  if (state.project) update();
  recap.refresh();
}

async function showLogoPreview() {
  const blob = await store.getMedia("brand:logo").catch(() => null);
  const img = $("#logo-preview");
  if (img.src) URL.revokeObjectURL(img.src);
  img.hidden = !blob;
  $("#logo-none").hidden = !!blob;
  if (blob) img.src = URL.createObjectURL(blob);
}
$("#logo-input").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  await store.saveMedia("brand:logo", f);
  showLogoPreview();
  recap.refresh();
  toast("Logo saved on this device.");
});

// ---------------------------------------------------------------------------
// Event recaps
const recap = createRecapEditor({ toast, busy, onHome: () => showHome(), getPrefs: () => state.prefs });
let recapTemplate = "photo";
$("#new-recap-files").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) recap.startNew(files, recapTemplate);
});

// ---------------------------------------------------------------------------
// Export
async function startExport() {
  stop();
  if (!state.d.total) return toast("Nothing to export.", true);
  const limit = state.prefs.maxSeconds;
  if (limit && state.d.total > limit + 0.05 && !confirm(`This story is ${state.d.total.toFixed(1)} s, over your ${limit} s limit. Export anyway?`)) {
    setTab("coach");
    return;
  }
  const sheet = $("#export-sheet");
  $("#export-title").textContent = "Exporting";
  $("#export-progress").value = 0;
  $("#export-progress").hidden = false;
  $("#export-status").textContent = "Keep this screen open.";
  $("#export-video").hidden = true;
  $("#export-actions").hidden = true;
  $("[data-action=close-export]").textContent = "Cancel";
  sheet.showModal();
  const abort = new AbortController();
  state.exportAbort = abort;
  let lock = null;
  try {
    lock = await navigator.wakeLock?.request("screen").catch(() => null);
    await loadFonts();
    const m = await media();
    const started = performance.now();
    const result = await m.exportStory({
      file: state.file,
      model: modelFor(),
      timeline: state.d.timeline,
      fps: 30,
      signal: abort.signal,
      onProgress: (f, text) => {
        $("#export-progress").value = f;
        $("#export-status").textContent = `${text} · ${Math.round(f * 100)}%`;
      },
    });
    if (state.exportResult?.url) URL.revokeObjectURL(state.exportResult.url);
    const name = `${state.project.name.replace(/[^\w\- ]+/g, "").trim() || "story"}.${result.ext}`;
    state.exportResult = { ...result, name, url: URL.createObjectURL(result.blob) };
    $("#export-title").textContent = "Ready to post";
    $("#export-progress").hidden = true;
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    $("#export-status").textContent = `${(result.blob.size / 1e6).toFixed(1)} MB · ${result.videoCodec.toUpperCase()}${result.audioCodec ? ` + ${result.audioCodec.toUpperCase()}` : " (no audio)"} · rendered in ${secs} s. Watch it once with sound before posting.`;
    const v = $("#export-video");
    v.src = state.exportResult.url;
    v.hidden = false;
    $("#export-actions").hidden = false;
    $("[data-action=share]").hidden = !navigator.canShare?.({ files: [new File([result.blob], name, { type: result.blob.type })] });
    $("[data-action=close-export]").textContent = "Close";
  } catch (err) {
    console.error(err);
    if (err.name === "AbortError") sheet.close();
    else {
      $("#export-title").textContent = "Export failed";
      $("#export-status").textContent = err.message || String(err);
      $("[data-action=close-export]").textContent = "Close";
    }
  } finally {
    lock?.release?.().catch(() => {});
    state.exportAbort = null;
  }
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function share() {
  const r = state.exportResult;
  const file = new File([r.blob], r.name, { type: r.blob.type });
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== "AbortError") toast(`Share failed: ${err.message}. Use Save video instead.`, true);
  }
}

// ---------------------------------------------------------------------------
// Events
document.addEventListener("click", async (ev) => {
  const wordBtn = ev.target.closest("[data-word]");
  if (wordBtn) return openWord(Number(wordBtn.dataset.word));
  const segBtn = ev.target.closest(".seg[data-setting] button");
  if (segBtn) return onSettingInput(segBtn.parentElement, segBtn.dataset.value);
  const tab = ev.target.closest("[data-tab]");
  if (tab) return setTab(tab.dataset.tab);
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  if (a === "pick-video") {
    $("#mode-sheet").close();
    $("#file-input").click();
  }
  else if (a === "open-settings") openSettings();
  else if (a === "open-project") {
    const p = await store.getProject(el.dataset.id);
    if (p?.mode === "recap") recap.open(el.dataset.id);
    else loadProject(el.dataset.id);
  } else if (a === "new-story") $("#mode-sheet").showModal();
  else if (a === "new-recap") {
    recapTemplate = el.dataset.template || "photo";
    $("#mode-sheet").close();
    $("#new-recap-files").click();
  } else if (a === "pick-logo") $("#logo-input").click();
  else if (a === "delete-project") {
    if (confirm("Delete this story and its media from this device?")) {
      await store.deleteProject(el.dataset.id);
      showHome();
    }
  } else if (a === "go-home") showHome();
  else if (a === "toggle-play") state.playing ? stop() : play();
  else if (a === "transcribe") runTranscription();
  else if (a === "import-transcript") $("#transcript-input").click();
  else if (a === "audition") audition(Number(el.dataset.start), Number(el.dataset.end));
  else if (a === "toggle-mistake") {
    const m = state.d.mistakes.find((x) => x.id === el.dataset.id);
    state.project.decisions[m.id] = !m.enabled;
    update();
  } else if (a === "fix") applyFix(el.dataset.fix);
  else if (a === "restore-ending") {
    state.project.trimEnd = null;
    update();
  }
  else if (a === "export") startExport();
  else if (a === "close-export") {
    state.exportAbort?.abort();
    $("#export-sheet").close();
  } else if (a === "share") share();
  else if (a === "download") download(state.exportResult.blob, state.exportResult.name);
  else if (a === "download-srt") download(new Blob([toSrt(state.d.captions)], { type: "text/plain" }), `${state.project.name}.srt`);
  else if (a === "download-kit") {
    const p = state.project;
    const bundle = kitBundle({ name: p.name, duration: p.media.duration, cuts: state.d.cuts, timeline: state.d.timeline, words: p.transcript?.words ?? [], outWords: state.d.outWords, params: { pace: p.settings.pace } });
    download(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }), `${p.name}.story-studio.json`);
  } else if (a === "word-play") {
    const w = state.d.words[state.wordIndex];
    $("#word-sheet").close();
    const t = outAt(state.d.timeline, w.start);
    if (t === null) audition(w.start, w.end);
    else {
      seekOut(Math.max(0, t - 0.3));
      play();
    }
  } else if (a === "word-cut") {
    const cut = !state.project.wordEdits[state.wordIndex]?.cut;
    editWord({ cut });
    $("#word-sheet").close();
  } else if (a === "wipe") {
    if (!confirm("Delete every story saved on this device? API keys stay.")) return;
    for (const p of await store.listProjects()) await store.deleteProject(p.id);
    $("#settings").close();
    showHome();
  } else if (a === "install") state.installEvent?.prompt();
});

for (const el of $$("input[data-setting]")) {
  el.addEventListener(el.type === "checkbox" ? "change" : "input", () => onSettingInput(el, el.value));
}
$("#file-input").addEventListener("change", (e) => {
  importFile(e.target.files[0]);
  e.target.value = "";
});
$("#transcript-input").addEventListener("change", (e) => {
  if (e.target.files[0]) importTranscript(e.target.files[0]);
  e.target.value = "";
});
$("#project-name").addEventListener("input", (e) => {
  state.project.name = e.target.value.trim() || "Untitled story";
  persist();
});
$("#scrub").addEventListener("input", (e) => {
  stop();
  seekOut(Number(e.target.value));
});
timelineCanvas.addEventListener("pointerdown", (e) => {
  stop();
  seekFromTimeline(e);
  const move = (m) => seekFromTimeline(m);
  timelineCanvas.addEventListener("pointermove", move);
  timelineCanvas.addEventListener("pointerup", () => timelineCanvas.removeEventListener("pointermove", move), { once: true });
});
preview.addEventListener("click", () => (state.playing ? stop() : play()));

// Word sheet controls
$("#word-text").addEventListener("change", (e) => editWord({ text: e.target.value.trim() || null }));
$("#word-serif").addEventListener("change", (e) => editWord({ serif: e.target.checked }));
for (const b of $$(".sw")) {
  b.addEventListener("click", () => {
    for (const x of $$(".sw")) x.classList.toggle("active", x === b);
    editWord({ color: b.dataset.color || null });
  });
}
$("#word-sheet").addEventListener("close", () => {
  const v = $("#word-text").value.trim();
  if (state.wordIndex !== null && state.project?.transcript) {
    const cur = state.project.wordEdits[state.wordIndex]?.text ?? state.project.transcript.words[state.wordIndex].text;
    if (v && v !== cur) editWord({ text: v });
  }
});

// Settings controls
for (const b of $$("#provider-seg button")) {
  b.addEventListener("click", () => {
    state.prefs.keys = { ...state.prefs.keys, [state.prefs.provider]: $("#api-key").value.trim() };
    state.prefs.provider = b.dataset.provider;
    renderProviderSettings();
  });
}
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue === "save") saveSettings();
});
$("#install-btn").addEventListener("click", async () => {
  await state.installEvent?.prompt();
  state.installEvent = null;
  updateInstallCard();
});
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  state.installEvent = e;
  updateInstallCard();
});
addEventListener("resize", () => state.project && renderTimeline());
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && state.project && !$("#editor").hidden && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
    e.preventDefault();
    state.playing ? stop() : play();
  }
});

// Clips shared from another app (Android share sheet) arrive via the service worker.
async function receiveShared() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("story-studio-share");
    const res = await cache.match("shared-video");
    if (!res) return;
    const blob = await res.blob();
    await cache.delete("shared-video");
    const name = decodeURIComponent(res.headers.get("x-file-name") || "shared.mp4");
    importFile(new File([blob], name, { type: blob.type || "video/mp4" }));
  } catch (err) {
    toast(`Could not open the shared clip: ${err.message}`, true);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered", err));
}

loadFonts().then(() => (state.dirty = true));
requestAnimationFrame(tick);
showHome().then(receiveShared);
