// Event recap planning: pure functions, no DOM or media access (tested in Node).
// The defaults encode the review notes from the first recap edited with the owner:
// native-looking sentence-case text only where the owner writes it, no automatic
// labels or title cards, one ending on the last real shot, a screen recording shown
// as a small phone beside the photos, long pauses cut, and cuts on a 120 BPM beat.
import { buildTimeline, srcAt } from "./edit-core.js";

export const BEAT = 0.5; // 120 BPM
export const HOOK_ONE_LINE = 3.5;
export const HOOK_TWO_LINES = 6.0;
export const HOOK_SECOND_LINE_AT = 3.0;
export const END_HOLD = 3.0;
export const PIP_SLIDE = 0.35;
export const WIPE = 1.0; // before/after reveal: two beats

// Story templates. Every line is a starting point the owner edits; nothing here is
// shown unless it stays in the story. Owners can save their own wording per template.
export const RECAP_TEMPLATES = {
  event: {
    label: "Event job",
    hook1: "___ days before the event, the client asked for ___.",
    hook2: "Can we do it?",
    endText: "We just did.",
    showLogo: true,
    captions: ["Day 1", "the night before", "self check-in kiosks", "check-in at the door", "and the conference app", "polls straight from the app", "full house"],
  },
  beforeafter: {
    label: "Before / after",
    hook1: "",
    hook2: "",
    endText: "",
    showLogo: false,
    captions: ["Before", "After", "Empty hall", "Show day", "The day before", "Done"],
    pairs: true,
  },
  photo: { label: "Photo story", hook1: "", hook2: "", endText: "", showLogo: false, captions: [] },
};

// A template with the owner's saved wording laid over the built-in lines.
export function templateFor(key, saved = {}) {
  const base = RECAP_TEMPLATES[key] ?? RECAP_TEMPLATES.photo;
  const own = saved?.[key] ?? {};
  return { ...structuredClone(base), ...structuredClone(own), key: RECAP_TEMPLATES[key] ? key : "photo" };
}

// Before/after: shots picked in pairs. Each second shot wipes in over the one before it.
export function pairShots(items, labels = ["Before", "After"]) {
  return items.map((it, i) => {
    const after = i % 2 === 1;
    return { ...it, reveal: after, text: it.text || labels[after ? 1 : 0] || "" };
  });
}

const BLANK = /_{2,}/;

export const RECAP_DEFAULTS = {
  hook1: "",
  hook2: "",
  endText: "",
  showLogo: false,
  music: true,
  photoSeconds: 2.5,
  pip: null, // { duration, width, height, keep: [{start,end}], cutPauses, from, to }
  template: "photo",
  captions: [], // quick captions for the shot list
};

const round = (n) => Math.round(n * 1000) / 1000;
export const snapBeat = (s, min = 1.5) => Math.max(min, Math.round(s / BEAT) * BEAT);

// Camera move for a shot, as fractions of the source (cx, cy centre; z zoom where
// 1 = the largest 9:16 crop). Landscape shots pan across; portrait shots push in,
// alternating so consecutive shots never repeat the same move; the last shot pulls back.
export function moveFor(item, index, isLast) {
  const aspect = (item.width || 1) / (item.height || 1);
  if (item.kind === "video") return { cx0: 0.5, cy0: 0.5, z0: 1.0, cx1: 0.5, cy1: 0.5, z1: 1.06 };
  if (isLast) return { cx0: 0.5, cy0: 0.56, z0: 1.16, cx1: 0.5, cy1: 0.5, z1: 1.0 };
  if (aspect > 0.8) {
    const ltr = index % 2 === 0;
    return { cx0: ltr ? 0.25 : 0.75, cy0: 0.5, z0: 1.0, cx1: ltr ? 0.75 : 0.25, cy1: 0.5, z1: 1.05 };
  }
  const dy = index % 2 === 0 ? 0.06 : -0.04;
  return { cx0: 0.5, cy0: 0.5, z0: 1.0, cx1: 0.5 - dy / 2, cy1: 0.5 + dy, z1: 1.14 };
}

function shotSeconds(item, photoSeconds, videoMax) {
  if (item.kind === "video") {
    const len = Math.max(0, (item.trimOut ?? item.duration ?? 0) - (item.trimIn ?? 0));
    return snapBeat(Math.min(len, videoMax), 1.5);
  }
  return snapBeat(photoSeconds, 1.5);
}

// Shots that wipe in over the previous one (never the first shot).
const reveals = (items) => items.map((it, i) => i > 0 && !!it.reveal);

/**
 * Lay the shots out on the beat grid and fit them to the length limit.
 * Returns segments (one per shot), the overlay schedule, PiP window and music cues.
 */
export function planRecap(items, opts = {}, limit = 0) {
  const o = { ...RECAP_DEFAULTS, ...opts };
  const warnings = [];
  if (!items.length) return { segments: [], texts: [], total: 0, pip: null, endAt: null, music: null, warnings: ["Add photos or clips to start."] };

  const hookLen = o.hook2.trim() ? HOOK_TWO_LINES : o.hook1.trim() ? HOOK_ONE_LINE : 0;
  const hasEnding = !!o.endText.trim() || o.showLogo;

  // The screen recording plays in full (after any trim or pause-cutting the owner
  // chose): the shots beside it stretch to its length rather than cutting it short.
  let pipKeep = null;
  let pipContent = 0;
  if (o.pip && o.pip.keep?.length) {
    const skip = o.pip.trimStart ?? 0;
    pipKeep = (o.pip.cutPauses ? o.pip.keep : [{ start: 0, end: o.pip.duration }])
      .map((k) => ({ start: Math.max(k.start, skip), end: k.end }))
      .filter((k) => k.end - k.start > 0.05);
    pipContent = pipKeep.reduce((a, k) => a + k.end - k.start, 0);
  }
  const pipFrom = Math.min(Math.max(0, o.pip?.from ?? 0), items.length - 1);
  const pipTo = Math.min(Math.max(pipFrom, o.pip?.to ?? items.length - 1), items.length - 1);

  let photo = o.photoSeconds;
  let videoMax = 6;
  const stretch = new Map(); // shot index -> extra seconds beside the recording
  const wipes = reveals(items);
  const layout = () => {
    let t = 0;
    return items.map((item, i) => {
      let dur = shotSeconds(item, photo, videoMax) + (wipes[i] ? WIPE : 0) + (stretch.get(i) ?? 0);
      if (i === 0 && hookLen) dur = Math.max(dur, hookLen);
      if (i === items.length - 1 && hasEnding) dur += END_HOLD;
      const seg = { index: i, item, start: t, end: t + dur };
      t += dur;
      return seg;
    });
  };
  let segments = layout();
  const total = () => segments.at(-1).end;
  // Fit to the limit by shortening shots, never by dropping the owner's shots.
  while (limit && total() > limit && (photo > 1.5 || videoMax > 3)) {
    if (photo > 1.5) photo -= BEAT;
    else videoMax -= 1;
    segments = layout();
  }
  if (pipContent > 0) {
    const covered = () => segments[pipTo].end - (hasEnding && pipTo === segments.length - 1 ? END_HOLD : 0) - segments[pipFrom].start;
    const short = pipContent - covered();
    if (short > 0.05) {
      const per = Math.ceil(short / (pipTo - pipFrom + 1) / BEAT) * BEAT;
      for (let i = pipFrom; i <= pipTo; i++) stretch.set(i, per);
      segments = layout();
    }
  }
  if (limit && total() > limit) {
    if (stretch.size) {
      warnings.push(`The full screen recording makes this story ${total().toFixed(1)} s, over your ${limit} s limit. Cut its pauses, skip its start, or raise the limit in Settings.`);
    } else {
      const extra = Math.ceil((total() - limit) / photo);
      warnings.push(`${total().toFixed(1)} s is over your ${limit} s limit. Remove about ${extra} shot${extra > 1 ? "s" : ""} or raise the limit in Settings.`);
    }
  }

  segments.forEach((s, i) => {
    s.start = round(s.start);
    s.end = round(s.end);
    s.move = moveFor(s.item, i, i === segments.length - 1 && segments.length > 1);
    s.srcIn = s.item.kind === "video" ? s.item.trimIn ?? 0 : 0;
    s.wipe = null;
  });
  // Before/after pairs share one centred, slowly tightening frame, so the after
  // shot lines up with the before shot as the divider sweeps across.
  segments.forEach((s, i) => {
    if (!wipes[i]) return;
    const prev = segments[i - 1];
    if (!prev.matched) prev.move = { cx0: 0.5, cy0: 0.5, z0: 1.0, cx1: 0.5, cy1: 0.5, z1: 1.05 };
    prev.matched = true;
    const z = prev.move.z1;
    s.move = { cx0: 0.5, cy0: 0.5, z0: z, cx1: 0.5, cy1: 0.5, z1: round(z + 0.05) };
    s.matched = true;
    s.wipe = { dur: WIPE };
  });

  const end = total();
  const endAt = hasEnding ? round(end - END_HOLD) : null;

  // Text overlays: the hook over the first shot, then the owner's own line per shot.
  const texts = [];
  if (hookLen) {
    const lines = [o.hook1.trim(), o.hook2.trim()].filter(Boolean);
    if (lines.length === 2) {
      texts.push({ start: 0, end: HOOK_SECOND_LINE_AT, lines: [lines[0]], place: "hook" });
      texts.push({ start: HOOK_SECOND_LINE_AT, end: segments[0].end, lines, place: "hook" });
    } else texts.push({ start: 0, end: segments[0].end, lines, place: "hook" });
  }
  segments.forEach((s, i) => {
    const line = (s.item.text ?? "").trim();
    if (!line || (i === 0 && hookLen)) return;
    // A before label stays up until the divider is halfway; the after label lands once it has crossed.
    const start = s.wipe ? round(s.start + s.wipe.dur) : s.start;
    let stop = segments[i + 1]?.wipe ? round(s.end + segments[i + 1].wipe.dur / 2) : s.end;
    if (endAt !== null && stop > endAt) stop = endAt;
    if (stop > start) texts.push({ start, end: stop, lines: [line], place: "top" });
  });
  if (endAt !== null && o.endText.trim()) texts.push({ start: endAt, end, lines: [o.endText.trim()], place: "top" });

  // Screen recording window: over the chosen shots, sliding out as the ending lands.
  let pip = null;
  if (pipKeep?.length) {
    const start = segments[pipFrom].start;
    let stop = segments[pipTo].end;
    if (endAt !== null) stop = Math.min(stop, endAt);
    if (stop - start >= 1) {
      const timeline = buildTimeline(pipKeep);
      const content = timeline.length ? timeline.at(-1).outEnd : 0;
      pip = { start, end: round(stop), timeline, content };
      // Shots snap to the beat, so a recording may end up to one beat per shot early.
      if (content < stop - start - BEAT * (pipTo - pipFrom + 1) - 0.05) warnings.push(`The screen recording is ${content.toFixed(1)} s but sits beside ${(stop - start).toFixed(1)} s of shots; it holds its last frame.`);
    }
  }

  const drop = hookLen ? segments[0].end : Math.min(2, segments[0].end);
  const music = o.music
    ? {
        dur: end,
        drop,
        groove_end: endAt !== null ? Math.min(end, endAt + 1) : end,
        hit: endAt,
        final: endAt !== null ? Math.min(end - 0.5, endAt + 1) : null,
        taps: [],
        whoosh: [...(pip ? [pip.start] : []), ...segments.filter((s) => s.wipe).map((s) => s.start)].sort((a, b) => a - b),
        crash: segments.filter((s, i) => i > 0 && i % 4 === 0).map((s) => s.start),
      }
    : null;

  // Template blanks left in: never post a "___".
  const blanks = [o.hook1, o.hook2, o.endText, ...items.map((it, i) => (i === 0 && hookLen ? "" : it.text ?? ""))].filter((l) => BLANK.test(l ?? ""));
  if (blanks.length) warnings.unshift(`Fill in the ___ before posting: "${blanks[0].trim()}"`);

  return { segments, texts, total: end, pip, endAt, music, warnings, photoSeconds: photo };
}

export function segmentAt(plan, t) {
  for (const s of plan.segments) if (t < s.end) return s;
  return plan.segments.at(-1);
}

// Smoothstep used for every camera move.
export const ease = (x) => x * x * (3 - 2 * x);

// Crop rectangle (source pixels) for a shot at progress p (0..1), output aspect W/H.
export function cropRect(move, p, sw, sh, W, H) {
  const e = ease(Math.min(1, Math.max(0, p)));
  const cx = (move.cx0 + (move.cx1 - move.cx0) * e) * sw;
  const cy = (move.cy0 + (move.cy1 - move.cy0) * e) * sh;
  const z = move.z0 + (move.z1 - move.z0) * e;
  const ch = Math.min(sh, (sw * H) / W) / z;
  const cw = (ch * W) / H;
  const x = Math.min(Math.max(cx - cw / 2, 0), sw - cw);
  const y = Math.min(Math.max(cy - ch / 2, 0), sh - ch);
  return { x, y, w: cw, h: ch };
}

// Picture-in-picture: where it sits (0 hidden .. 1 in place) and which source time to show.
export function pipStateAt(pip, t) {
  if (!pip || t < pip.start || t >= pip.end + PIP_SLIDE) return null;
  const slide = t < pip.end ? Math.min(1, (t - pip.start) / PIP_SLIDE) : Math.max(0, 1 - (t - pip.end) / PIP_SLIDE);
  const u = Math.min(t - pip.start, Math.max(0, pip.content - 0.02));
  return { slide: ease(slide), src: srcAt(pip.timeline, u) };
}

// ---------------------------------------------------------------------------
// Long-pause removal for screen recordings. `diffs[i]` is the mean absolute
// difference (0-255) between sampled frames i-1 and i at `rate` samples per second.
// Still runs of at least `minStill` seconds are cut down to `hold` seconds, which
// removes loading spinners and idle moments but keeps a beat to read each screen.
export function motionKeepRanges(diffs, rate, { threshold = 1.2, minStill = 0.6, hold = 0.35, duration } = {}) {
  const dur = duration ?? diffs.length / rate;
  const still = diffs.map((d, i) => i > 0 && d < threshold);
  const cuts = [];
  let i = 0;
  while (i < still.length) {
    if (!still[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < still.length && still[j]) j++;
    const a = (i - 1) / rate;
    const b = j >= still.length ? dur : (j - 1) / rate;
    // A still opening (splash or launch screen) goes entirely.
    const keepFor = i === 1 ? 0 : hold;
    if (b - a >= minStill) cuts.push({ start: round(a + keepFor), end: round(b) });
    i = j;
  }
  const keep = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start - cursor > 0.05) keep.push({ start: round(cursor), end: round(c.start) });
    cursor = c.end;
  }
  if (dur - cursor > 0.05) keep.push({ start: round(cursor), end: round(dur) });
  return keep;
}
