// Event recap editor: photos and clips from an event, in the owner's order, with
// their own words, an optional screen recording beside the shots, and a beat.
import * as store from "./store.js";
import { planRecap, RECAP_DEFAULTS, pipStateAt, segmentAt } from "./recap-core.js";
import { drawRecapFrame } from "./recap-render.js";
import { renderMusic, musicToWav } from "./music.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let mediaModule = null;
const media = () => (mediaModule ??= import("./recap-media.js"));

export function createRecapEditor({ toast, busy, onHome, getPrefs }) {
  const screen = $("#recap");
  const canvas = $("#recap-preview");
  const ctx = canvas.getContext("2d");
  const audio = new Audio();
  audio.preload = "auto";

  const S = {
    project: null,
    files: new Map(), // itemId -> File
    bitmaps: new Map(), // itemId -> ImageBitmap (preview size)
    videos: new Map(), // itemId -> HTMLVideoElement
    urls: [],
    pipFile: null,
    pipEl: null,
    logo: null,
    plan: null,
    musicKey: "",
    music: null,
    playing: false,
    t: 0,
    clock: 0,
    dirty: true,
    exportResult: null,
    abort: null,
  };

  // ---------------------------------------------------------------- data
  const R = () => S.project.recap;
  function replan() {
    const r = R();
    const items = r.items.map((it) => ({ ...it }));
    S.plan = planRecap(items, r, getPrefs().maxSeconds || 0);
    S.t = Math.min(S.t, S.plan.total);
    renderSummary();
    scheduleMusic();
    S.dirty = true;
  }
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      S.project.thumb = R().items[0]?.thumb ?? null;
      store.saveProject(S.project).catch((e) => toast(`Could not save: ${e.message}`, true));
    }, 400);
  }
  function changed({ list = false } = {}) {
    replan();
    if (list) renderShots();
    renderExtras();
    persist();
  }

  let musicTimer = 0;
  function scheduleMusic() {
    const cfg = S.plan.music;
    const key = cfg ? JSON.stringify({ ...cfg, seed: S.project.id.length }) : "";
    if (key === S.musicKey) return;
    S.musicKey = key;
    clearTimeout(musicTimer);
    if (!cfg) {
      S.music = null;
      audio.removeAttribute("src");
      return;
    }
    musicTimer = setTimeout(() => {
      const pcm = renderMusic({ ...cfg, seed: hash(S.project.id) });
      S.music = pcm;
      const url = URL.createObjectURL(new Blob([musicToWav(pcm)], { type: "audio/wav" }));
      S.urls.push(url);
      audio.src = url;
    }, 500);
  }
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

  // ---------------------------------------------------------------- media
  async function attach(item, file) {
    S.files.set(item.id, file);
    if (item.kind === "photo") {
      const m = await media();
      S.bitmaps.set(item.id, await m.loadBitmap(file, 1600));
    } else {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      const url = URL.createObjectURL(file);
      S.urls.push(url);
      v.src = url;
      v.addEventListener("seeked", () => (S.dirty = true));
      v.addEventListener("loadeddata", () => (S.dirty = true));
      S.videos.set(item.id, v);
    }
  }

  async function addFiles(fileList) {
    const m = await media();
    const files = [...fileList];
    let added = 0;
    for (const [n, file] of files.entries()) {
      busy(`Adding ${n + 1} of ${files.length}…`);
      try {
        const info = await m.probeItem(file);
        const item = { id: uid(), name: file.name, type: file.type, ...info, text: "" };
        if (item.kind === "video") {
          item.trimIn = 0;
          item.trimOut = Math.min(info.duration, 4);
        }
        await store.saveMedia(`${S.project.id}:${item.id}`, file);
        await attach(item, file);
        R().items.push(item);
        added++;
      } catch (err) {
        toast(err.message || String(err), true);
      }
    }
    busy(null);
    if (added) changed({ list: true });
  }

  async function setRecording(file) {
    const m = await media();
    busy("Finding the pauses in your recording…");
    try {
      const info = await m.analyzeRecording(file, (f) => busy(`Finding the pauses… ${Math.round(f * 100)}%`));
      await store.saveMedia(`${S.project.id}:pip`, file);
      S.pipFile = file;
      attachPipEl(file);
      const n = R().items.length;
      R().pip = { ...info, cutPauses: false, trimStart: 0, from: Math.max(1, Math.min(n - 1, n - 3)), to: Math.max(0, n - 1) };
      const kept = info.keep.reduce((a, k) => a + k.end - k.start, 0);
      toast(`Recording added: ${info.duration.toFixed(1)} s, played in full. Cutting pauses would make it ${kept.toFixed(1)} s.`);
      changed();
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      busy(null);
    }
  }
  function attachPipEl(file) {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    const url = URL.createObjectURL(file);
    S.urls.push(url);
    v.src = url;
    v.addEventListener("seeked", () => (S.dirty = true));
    S.pipEl = v;
  }

  // ---------------------------------------------------------------- open / close
  async function startNew(files) {
    const project = {
      id: uid(),
      mode: "recap",
      name: `Event recap ${new Date().toLocaleDateString()}`,
      created: Date.now(),
      recap: { ...structuredClone(RECAP_DEFAULTS), showLogo: false, items: [] },
      thumb: null,
    };
    await show(project);
    await addFiles(files);
    store.requestPersistence();
  }

  async function open(id) {
    busy("Opening…");
    try {
      const project = await store.getProject(id);
      project.recap = { ...structuredClone(RECAP_DEFAULTS), ...project.recap };
      await show(project);
      for (const item of project.recap.items) {
        const file = await store.getMedia(`${id}:${item.id}`);
        if (file) await attach(item, file);
      }
      if (project.recap.pip) {
        const f = await store.getMedia(`${id}:pip`);
        if (f) {
          S.pipFile = f;
          attachPipEl(f);
        } else project.recap.pip = null;
      }
      changed({ list: true });
    } catch (err) {
      toast(err.message || String(err), true);
      onHome();
    } finally {
      busy(null);
    }
  }

  async function show(project) {
    cleanup();
    S.project = project;
    $("#home").hidden = true;
    $("#editor").hidden = true;
    screen.hidden = false;
    $("#recap-name").value = project.name;
    setTab("shots");
    const logoBlob = await store.getMedia("brand:logo").catch(() => null);
    S.logo = logoBlob ? await createImageBitmap(logoBlob).catch(() => null) : null;
    replan();
    renderShots();
    renderOpening();
    renderExtras();
  }

  function cleanup() {
    stop();
    for (const u of S.urls) URL.revokeObjectURL(u);
    S.urls = [];
    for (const b of S.bitmaps.values()) b.close?.();
    S.files.clear();
    S.bitmaps.clear();
    S.videos.clear();
    S.pipFile = null;
    S.pipEl = null;
    S.musicKey = "";
    S.music = null;
    S.t = 0;
  }

  function close() {
    cleanup();
    S.project = null;
    screen.hidden = true;
  }

  // ---------------------------------------------------------------- rendering of panels
  function renderSummary() {
    const p = S.plan;
    const limit = getPrefs().maxSeconds || 0;
    const over = limit && p.total > limit + 0.01;
    $("#recap-summary").textContent = `${fmt(p.total)} · ${p.segments.length} shot${p.segments.length === 1 ? "" : "s"}${limit ? ` · limit ${limit} s` : ""}${p.photoSeconds !== R().photoSeconds ? ` · photos shortened to ${p.photoSeconds} s to fit` : ""}`;
    $("#recap-summary").classList.toggle("over", !!over);
    $("#recap-warnings").innerHTML = p.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    $("#recap-scrub").max = Math.max(0.01, p.total).toFixed(2);
  }

  function renderShots() {
    const items = R().items;
    $("#recap-shots").innerHTML = items
      .map((it, i) => {
        const seg = S.plan.segments[i];
        const len = seg ? seg.end - seg.start : 0;
        const trim =
          it.kind === "video"
            ? `<div class="trim">
                <label>Start at <output>${(it.trimIn ?? 0).toFixed(1)} s</output></label>
                <input type="range" min="0" max="${Math.max(0, it.duration - 1.5).toFixed(1)}" step="0.1" value="${it.trimIn ?? 0}" data-trim-in="${i}">
                <label>Length <output>${((it.trimOut ?? 0) - (it.trimIn ?? 0)).toFixed(1)} s</output></label>
                <input type="range" min="1.5" max="${Math.min(6, Math.max(1.5, it.duration)).toFixed(1)}" step="0.5" value="${((it.trimOut ?? 0) - (it.trimIn ?? 0)).toFixed(1)}" data-trim-len="${i}">
              </div>`
            : "";
        return `<li class="shot">
          <div class="shot-row">
            <button class="shot-thumb" data-recap-seek="${i}" aria-label="Preview shot ${i + 1}">${it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : ""}<span>${i + 1}</span></button>
            <div class="shot-main">
              <div class="shot-meta">${it.kind === "video" ? "Clip" : "Photo"} · ${len.toFixed(1)} s${i === 0 && (R().hook1 || R().hook2) ? " · opening" : ""}${i === items.length - 1 && (R().endText || R().showLogo) ? " · ending" : ""}</div>
              <input type="text" class="shot-text" data-shot-text="${i}" value="${esc(it.text)}" placeholder="${i === 0 && (R().hook1 || R().hook2) ? "Opening text shows here" : "Text on this shot (optional)"}" maxlength="80" ${i === 0 && (R().hook1 || R().hook2) ? "disabled" : ""}>
            </div>
            <div class="shot-tools">
              <button class="icon-btn sm" data-shot-move="${i}:-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
              <button class="icon-btn sm" data-shot-move="${i}:1" aria-label="Move down" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
              <button class="icon-btn sm danger" data-shot-remove="${i}" aria-label="Remove">✕</button>
            </div>
          </div>
          ${trim}
        </li>`;
      })
      .join("");
    $("#recap-empty").hidden = items.length > 0;
  }

  function renderOpening() {
    const r = R();
    $("#recap-hook1").value = r.hook1;
    $("#recap-hook2").value = r.hook2;
    $("#recap-end").value = r.endText;
    $("#recap-logo").checked = r.showLogo;
    $("#recap-photo-len").value = r.photoSeconds;
    $("#recap-photo-len-out").textContent = `${r.photoSeconds} s`;
    $("#recap-logo-note").textContent = S.logo ? "Your logo appears small, under the ending line." : "No logo yet: add it once in Settings › Brand logo.";
  }

  function renderExtras() {
    const r = R();
    const pip = r.pip;
    const box = $("#recap-pip");
    if (!pip) {
      box.innerHTML = `<p class="hint">Plays in full as a small phone beside your shots; those shots stretch to fit it. You can cut long pauses after adding it.</p>
        <button class="btn" data-recap="add-recording">Add screen recording</button>`;
    } else {
      const kept = pip.keep.reduce((a, k) => a + k.end - k.start, 0);
      const opts = (sel) => r.items.map((_, i) => `<option value="${i}" ${i === sel ? "selected" : ""}>Shot ${i + 1}</option>`).join("");
      box.innerHTML = `<p class="hint">${pip.duration.toFixed(1)} s recording${pip.cutPauses ? ` → ${kept.toFixed(1)} s after cutting pauses` : ""}.</p>
        <label class="switch"><input type="checkbox" data-recap="pip-cut" ${pip.cutPauses ? "checked" : ""}><span>Cut long pauses and loading screens</span></label>
        <label>Skip the first <output id="pip-skip-out">${(pip.trimStart ?? 0).toFixed(1)} s</output></label>
        <input type="range" min="0" max="${Math.min(15, Math.max(0, pip.duration - 2)).toFixed(1)}" step="0.1" value="${pip.trimStart ?? 0}" data-recap="pip-skip">
        <div class="row two"><div><label>Show from</label><select data-recap="pip-from">${opts(pip.from)}</select></div><div><label>to</label><select data-recap="pip-to">${opts(pip.to)}</select></div></div>
        <button class="btn danger" data-recap="remove-recording">Remove recording</button>`;
    }
    for (const b of document.querySelectorAll("#recap-music button")) b.classList.toggle("active", String(r.music) === b.dataset.value);
  }

  function setTab(name) {
    for (const t of screen.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.rtab === name);
    for (const p of screen.querySelectorAll(".tab-panel")) p.hidden = p.dataset.rpanel !== name;
  }

  // ---------------------------------------------------------------- preview
  function sources() {
    return {
      shot: (seg) => {
        const it = seg.item;
        if (it.kind === "photo") {
          const b = S.bitmaps.get(it.id);
          return b ? { img: b, w: b.width, h: b.height } : null;
        }
        const v = S.videos.get(it.id);
        return v && v.readyState >= 2 ? { img: v, w: v.videoWidth, h: v.videoHeight } : null;
      },
      pip: () => (S.pipEl && S.pipEl.readyState >= 2 ? { img: S.pipEl, w: S.pipEl.videoWidth, h: S.pipEl.videoHeight } : null),
      logo: S.logo,
    };
  }

  function syncMedia(playing) {
    const plan = S.plan;
    if (!plan?.segments.length) return;
    const seg = segmentAt(plan, S.t);
    for (const [id, v] of S.videos) {
      if (id !== seg.item.id) {
        if (!v.paused) v.pause();
        continue;
      }
      const want = seg.srcIn + (S.t - seg.start);
      if (Math.abs(v.currentTime - want) > (playing ? 0.3 : 0.04)) v.currentTime = want;
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
    if (S.pipEl) {
      const st = pipStateAt(plan.pip, S.t);
      if (st) {
        if (Math.abs(S.pipEl.currentTime - st.src) > (playing ? 0.25 : 0.04)) S.pipEl.currentTime = st.src;
        if (playing && S.pipEl.paused) S.pipEl.play().catch(() => {});
      } else if (!S.pipEl.paused) S.pipEl.pause();
      if (!playing && !S.pipEl.paused) S.pipEl.pause();
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!S.project || !S.plan || screen.hidden) return;
    if (S.playing) {
      S.t = S.music && !audio.paused ? audio.currentTime : (performance.now() - S.clock) / 1000;
      if (S.t >= S.plan.total) {
        stop();
        S.t = 0;
      }
      syncMedia(S.playing);
      S.dirty = true;
    }
    if (S.dirty) {
      S.dirty = false;
      drawRecapFrame(ctx, canvas.width, canvas.height, S.plan, S.t, sources(), { showLogo: R().showLogo, guides: true });
      $("#recap-time").textContent = `${fmt(S.t)} / ${fmt(S.plan.total)}`;
      if (document.activeElement !== $("#recap-scrub")) $("#recap-scrub").value = S.t.toFixed(2);
    }
  }
  requestAnimationFrame(tick);

  function play() {
    if (!S.plan?.total) return;
    if (S.t >= S.plan.total - 0.05) S.t = 0;
    S.playing = true;
    $("#recap-play").classList.add("playing");
    if (S.music && audio.src) {
      audio.currentTime = S.t;
      audio.play().catch(() => {
        S.clock = performance.now() - S.t * 1000;
      });
    }
    S.clock = performance.now() - S.t * 1000;
  }
  function stop() {
    S.playing = false;
    audio.pause();
    $("#recap-play")?.classList.remove("playing");
    for (const v of S.videos.values()) v.pause();
    S.pipEl?.pause();
  }
  function seek(t) {
    stop();
    S.t = Math.max(0, Math.min(t, S.plan.total));
    syncMedia(false);
    S.dirty = true;
  }

  // ---------------------------------------------------------------- export
  async function exportNow() {
    stop();
    const plan = S.plan;
    if (!plan.total) return toast("Add photos or clips first.", true);
    const limit = getPrefs().maxSeconds || 0;
    if (limit && plan.total > limit + 0.05 && !confirm(`This story is ${plan.total.toFixed(1)} s, over your ${limit} s limit. Export anyway?`)) return;
    const sheet = $("#recap-export");
    $("#rx-title").textContent = "Exporting";
    $("#rx-progress").hidden = false;
    $("#rx-progress").value = 0;
    $("#rx-status").textContent = "Keep this screen open.";
    $("#rx-video").hidden = true;
    $("#rx-actions").hidden = true;
    $("#rx-close").textContent = "Cancel";
    sheet.showModal();
    const abort = new AbortController();
    S.abort = abort;
    let lock = null;
    try {
      lock = await navigator.wakeLock?.request("screen").catch(() => null);
      await document.fonts?.load?.('650 54px "Inter"');
      const m = await media();
      const shots = [];
      for (const seg of plan.segments) {
        const file = S.files.get(seg.item.id);
        shots.push(seg.item.kind === "photo" ? { kind: "photo", file, bitmap: await m.loadBitmap(file) } : { kind: "video", file });
      }
      const music = plan.music ? (S.music && S.musicKey === JSON.stringify({ ...plan.music, seed: S.project.id.length }) ? S.music : renderMusic({ ...plan.music, seed: hash(S.project.id) })) : null;
      const started = performance.now();
      const result = await m.exportRecap({
        plan,
        shots,
        pipFile: S.pipFile,
        logo: R().showLogo ? S.logo : null,
        music,
        settings: R(),
        signal: abort.signal,
        onProgress: (f, text) => {
          $("#rx-progress").value = f;
          $("#rx-status").textContent = `${text} · ${Math.round(f * 100)}%`;
        },
      });
      for (const s of shots) s.bitmap?.close?.();
      if (S.exportResult?.url) URL.revokeObjectURL(S.exportResult.url);
      const name = `${S.project.name.replace(/[^\w\- ]+/g, "").trim() || "recap"}.${result.ext}`;
      S.exportResult = { ...result, name, url: URL.createObjectURL(result.blob) };
      $("#rx-title").textContent = "Ready to post";
      $("#rx-progress").hidden = true;
      $("#rx-status").textContent = `${(result.blob.size / 1e6).toFixed(1)} MB · ${plan.total.toFixed(1)} s · rendered in ${((performance.now() - started) / 1000).toFixed(0)} s. Watch it once with sound before posting.`;
      const v = $("#rx-video");
      v.src = S.exportResult.url;
      v.hidden = false;
      $("#rx-actions").hidden = false;
      $("#rx-share").hidden = !navigator.canShare?.({ files: [new File([result.blob], name, { type: result.blob.type })] });
      $("#rx-close").textContent = "Close";
    } catch (err) {
      console.error(err);
      if (err.name === "AbortError") sheet.close();
      else {
        $("#rx-title").textContent = "Export failed";
        $("#rx-status").textContent = err.message || String(err);
        $("#rx-close").textContent = "Close";
      }
    } finally {
      lock?.release?.().catch(() => {});
      S.abort = null;
    }
  }

  // ---------------------------------------------------------------- events
  screen.addEventListener("click", async (ev) => {
    const tab = ev.target.closest("[data-rtab]");
    if (tab) return setTab(tab.dataset.rtab);
    const mv = ev.target.closest("[data-shot-move]");
    if (mv) {
      const [i, d] = mv.dataset.shotMove.split(":").map(Number);
      const items = R().items;
      [items[i], items[i + d]] = [items[i + d], items[i]];
      return changed({ list: true });
    }
    const rm = ev.target.closest("[data-shot-remove]");
    if (rm) {
      const i = Number(rm.dataset.shotRemove);
      const [item] = R().items.splice(i, 1);
      store.deleteMedia(`${S.project.id}:${item.id}`).catch(() => {});
      S.files.delete(item.id);
      S.bitmaps.get(item.id)?.close?.();
      S.bitmaps.delete(item.id);
      S.videos.delete(item.id);
      if (R().pip) {
        const n = R().items.length;
        R().pip.from = Math.min(R().pip.from, Math.max(0, n - 1));
        R().pip.to = Math.min(R().pip.to, Math.max(0, n - 1));
      }
      return changed({ list: true });
    }
    const sk = ev.target.closest("[data-recap-seek]");
    if (sk) {
      const seg = S.plan.segments[Number(sk.dataset.recapSeek)];
      if (seg) seek(seg.start + 0.05);
      return;
    }
    const mus = ev.target.closest("#recap-music button");
    if (mus) {
      R().music = mus.dataset.value === "true";
      return changed();
    }
    const el = ev.target.closest("[data-recap]");
    if (!el) return;
    const a = el.dataset.recap;
    if (a === "home") {
      close();
      onHome();
    } else if (a === "play") S.playing ? stop() : play();
    else if (a === "add") $("#recap-files").click();
    else if (a === "add-recording") $("#recap-recording").click();
    else if (a === "remove-recording") {
      R().pip = null;
      S.pipFile = null;
      S.pipEl = null;
      store.deleteMedia(`${S.project.id}:pip`).catch(() => {});
      changed();
    } else if (a === "export") exportNow();
  });

  screen.addEventListener("input", (ev) => {
    const el = ev.target;
    const r = R();
    if (el.matches("[data-shot-text]")) {
      r.items[Number(el.dataset.shotText)].text = el.value;
      return changed();
    }
    if (el.matches("[data-trim-in]")) {
      const it = r.items[Number(el.dataset.trimIn)];
      const len = it.trimOut - it.trimIn;
      it.trimIn = Number(el.value);
      it.trimOut = Math.min(it.duration, it.trimIn + len);
      el.previousElementSibling.querySelector("output").textContent = `${it.trimIn.toFixed(1)} s`;
      return changed();
    }
    if (el.matches("[data-trim-len]")) {
      const it = r.items[Number(el.dataset.trimLen)];
      it.trimOut = Math.min(it.duration, it.trimIn + Number(el.value));
      el.previousElementSibling.querySelector("output").textContent = `${(it.trimOut - it.trimIn).toFixed(1)} s`;
      return changed();
    }
    if (el.id === "recap-hook1" || el.id === "recap-hook2" || el.id === "recap-end") {
      r.hook1 = $("#recap-hook1").value;
      r.hook2 = $("#recap-hook2").value;
      r.endText = $("#recap-end").value;
      return changed();
    }
    if (el.id === "recap-photo-len") {
      r.photoSeconds = Number(el.value);
      $("#recap-photo-len-out").textContent = `${r.photoSeconds} s`;
      return changed();
    }
    if (el.id === "recap-scrub") return seek(Number(el.value));
    if (el.dataset.recap === "pip-skip") {
      r.pip.trimStart = Number(el.value);
      $("#pip-skip-out").textContent = `${r.pip.trimStart.toFixed(1)} s`;
      replan();
      return persist();
    }
    if (el.id === "recap-name") {
      S.project.name = el.value.trim() || "Event recap";
      return persist();
    }
  });

  screen.addEventListener("change", (ev) => {
    const el = ev.target;
    const r = R();
    if (el.id === "recap-logo") {
      r.showLogo = el.checked;
      return changed();
    }
    if (el.matches("[data-shot-text]") || el.matches("[data-trim-in]") || el.matches("[data-trim-len]") || el.id === "recap-hook1" || el.id === "recap-hook2") return renderShots();
    const a = el.dataset.recap;
    if (a === "pip-cut") r.pip.cutPauses = el.checked;
    if (a === "pip-from") {
      r.pip.from = Number(el.value);
      r.pip.to = Math.max(r.pip.to, r.pip.from);
    }
    if (a === "pip-to") {
      r.pip.to = Number(el.value);
      r.pip.from = Math.min(r.pip.from, r.pip.to);
    }
    if (a) changed();
  });

  $("#recap-files").addEventListener("change", (e) => {
    if (e.target.files.length) addFiles(e.target.files);
    e.target.value = "";
  });
  $("#recap-recording").addEventListener("change", (e) => {
    if (e.target.files[0]) setRecording(e.target.files[0]);
    e.target.value = "";
  });
  canvas.addEventListener("click", () => (S.playing ? stop() : play()));

  // Export sheet
  $("#recap-export").addEventListener("click", async (ev) => {
    const id = ev.target.closest("button")?.id;
    const r = S.exportResult;
    if (id === "rx-close") {
      S.abort?.abort();
      $("#recap-export").close();
    } else if (id === "rx-share" && r) {
      try {
        await navigator.share({ files: [new File([r.blob], r.name, { type: r.blob.type })] });
      } catch (err) {
        if (err.name !== "AbortError") toast(`Share failed: ${err.message}. Use Save video instead.`, true);
      }
    } else if (id === "rx-save" && r) {
      const a = document.createElement("a");
      a.href = r.url;
      a.download = r.name;
      document.body.append(a);
      a.click();
      a.remove();
    }
  });

  return {
    startNew,
    open,
    close,
    // Settings changed (length limit or logo): reload the logo and re-plan in place.
    async refresh() {
      if (!S.project) return;
      const logoBlob = await store.getMedia("brand:logo").catch(() => null);
      S.logo = logoBlob ? await createImageBitmap(logoBlob).catch(() => null) : null;
      renderOpening();
      changed({ list: true });
    },
    get active() {
      return !!S.project && !screen.hidden;
    },
  };
}
