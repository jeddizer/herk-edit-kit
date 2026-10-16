// Story Studio edit core: pure functions with no DOM or media access.
// Ports the kit's cut-silences and find-cut-candidates logic and applies the
// short-form house style from docs/EDITING-PLAYBOOK.md. Node tests import this file.

// ---------------------------------------------------------------------------
// Pace presets. "natural" mirrors cut-silences defaults; "tight" follows the
// measured reel style: dead air under ~0.2 s, natural beats of 0.2-0.4 s after
// commas and sentence ends, speech within ~0.1 s of the first frame.
export const PACE = {
  off: null,
  natural: { gap: 0.55, headPad: 0.22, tailPad: 0.34, keepShort: 0.14, keepComma: 0.2, keepSentence: 0.2, keepLong: 0.24 },
  tight: { gap: 0.3, headPad: 0.08, tailPad: 0.22, keepShort: 0.15, keepComma: 0.25, keepSentence: 0.3, keepLong: 0.3 },
};

// Transcripts end words 40-80 ms before the consonant decays, so a cut never
// starts closer than this to the end of the previous word.
const MIN_POSTROLL = 0.08;
const MIN_PREROLL = 0.05;
const MIN_KEEP = 0.04;

const round = (n) => Math.round(n * 1000) / 1000;
const SENTENCE_END = /[.!?…]["')\]]*$/;
const PHRASE_END = /[.!?…,;:—–-]["')\]]*$/;

export function cleanToken(text) {
  return String(text ?? "").toLowerCase().replace(/^[^\p{L}\p{N}$%]+|[^\p{L}\p{N}$%]+$/gu, "");
}

// ---------------------------------------------------------------------------
// Transcript normalisation. Accepts the kit format ({ words: [{ text, start, end }] }),
// ElevenLabs Scribe (type === "word"), and Whisper verbose_json from OpenAI or Groq
// ({ words: [{ word, start, end }] } or words nested inside segments).
export function normalizeTranscript(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Transcript is not a JSON object.");
  let list = Array.isArray(raw.words) ? raw.words : null;
  if (!list && Array.isArray(raw.segments)) list = raw.segments.flatMap((s) => (Array.isArray(s.words) ? s.words : []));
  if (!list || list.length === 0) throw new Error("This transcript has no word-level timestamps.");

  let words = list
    .filter((w) => (w.type ? w.type === "word" : true))
    .map((w) => ({ text: String(w.text ?? w.word ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);

  // Whisper word timestamps drop punctuation; recover it from the full text so
  // sentence and phrase boundaries still drive cuts and captions.
  const fullText = typeof raw.text === "string" ? raw.text : Array.isArray(raw.segments) ? raw.segments.map((s) => s.text ?? "").join(" ") : "";
  if (fullText && !words.some((w) => PHRASE_END.test(w.text))) words = attachPunctuation(words, fullText);

  // Repair overlaps so every downstream range stays ordered.
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].end) words[i - 1].end = Math.max(words[i - 1].start, words[i].start);
  }
  const duration = Number(raw.audio_duration_secs ?? raw.duration);
  return {
    words: words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })),
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    language: raw.language_code ?? raw.language ?? null,
  };
}

export function attachPunctuation(words, fullText) {
  const tokens = fullText.split(/\s+/).filter(Boolean);
  let cursor = 0;
  return words.map((w) => {
    const target = cleanToken(w.text);
    for (let k = cursor; k < Math.min(tokens.length, cursor + 4); k++) {
      if (cleanToken(tokens[k]) === target) {
        cursor = k + 1;
        return { ...w, text: tokens[k] };
      }
    }
    return w;
  });
}

// ---------------------------------------------------------------------------
// Speech regions from an RMS envelope (dB per hop). Used when no transcript is
// available: each region behaves like a "word" for the silence trimmer.
export function speechRegionsFromEnvelope(envelope, hop = 0.01) {
  const n = envelope.length;
  if (!n) return [];
  const threshold = envelopeThreshold(envelope);

  const regions = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && envelope[i] >= threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      regions.push({ start: start * hop, end: i * hop });
      start = -1;
    }
  }
  // Bridge the short dips inside words, then drop clicks.
  const bridged = [];
  for (const r of regions) {
    const last = bridged.at(-1);
    if (last && r.start - last.end < 0.15) last.end = r.end;
    else bridged.push({ ...r });
  }
  return bridged.filter((r) => r.end - r.start >= 0.08).map((r) => ({ text: "", start: round(r.start), end: round(r.end) }));
}

export const ENVELOPE_HOP = 0.01;
const thresholds = new WeakMap();

function envelopeThreshold(envelope) {
  if (typeof envelope === "object" && thresholds.has(envelope)) return thresholds.get(envelope);
  const sorted = Array.from(envelope).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = Math.max(floor + 6, floor + (loud - floor) * 0.3);
  if (typeof envelope === "object") thresholds.set(envelope, threshold);
  return threshold;
}

// Whisper often stretches a word across the pause that follows (or precedes)
// it, which hides dead air from the trimmer. Pull each word's edges in to its
// voiced audio when a silent run of at least minSilence sits inside its span.
// Word count and order are preserved so per-word edits keep their indices.
export function refineWordTimings(words, envelope, hop = 0.01, { minSilence = 0.25 } = {}) {
  if (!envelope?.length || !words.length) return words;
  const threshold = envelopeThreshold(envelope);
  const voiced = (k) => k >= 0 && k < envelope.length && envelope[k] >= threshold;
  const minRun = Math.round(minSilence / hop);
  return words.map((w) => {
    const a = Math.max(0, Math.floor(w.start / hop));
    const b = Math.min(envelope.length, Math.ceil(w.end / hop));
    let first = -1;
    let last = -1;
    for (let k = a; k < b; k++) {
      if (voiced(k)) {
        if (first < 0) first = k;
        last = k;
      }
    }
    if (first < 0) return w; // a quiet word; trust the transcript
    let { start, end } = w;
    if (first - a >= minRun) start = Math.max(w.start, first * hop - 0.04);
    if (b - 1 - last >= minRun) end = Math.min(w.end, (last + 1) * hop + 0.06);
    return end - start >= 0.05 && (start !== w.start || end !== w.end) ? { ...w, start: round(start), end: round(end) } : w;
  });
}

// ---------------------------------------------------------------------------
// Silence cuts: head/tail dead air and long pauses, trimmed to a natural breath.
export function silenceCuts(words, duration, paceName = "tight") {
  const p = PACE[paceName];
  if (!p || !words.length) return [];
  const cuts = [];
  const headEnd = words[0].start - p.headPad;
  if (headEnd > 0.02) cuts.push({ kind: "silence", start: 0, end: round(headEnd), note: "Dead air before the first word" });
  const tailStart = words.at(-1).end + p.tailPad;
  if (duration - tailStart > 0.02) cuts.push({ kind: "silence", start: round(tailStart), end: round(duration), note: "Dead air after the last word" });

  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const next = words[i];
    const gap = next.start - prev.end;
    if (gap < p.gap) continue;
    const keep = gap >= 2 ? p.keepLong : SENTENCE_END.test(prev.text) ? p.keepSentence : PHRASE_END.test(prev.text) ? p.keepComma : p.keepShort;
    const start = prev.end + Math.max(MIN_POSTROLL, keep * 0.55);
    const end = next.start - Math.max(MIN_PREROLL, keep * 0.45);
    if (end - start > 0.06) cuts.push({ kind: "silence", start: round(start), end: round(end), note: `Pause ${gap.toFixed(2)} s → ${(gap - (end - start)).toFixed(2)} s` });
  }
  return cuts;
}

// Safety net from the audio itself: any silence of minGap or more is cut down
// to a short breath even if transcript timing claims a word spans it.
export function longSilenceCuts(regions, paceName = "tight", minGap = 0.8) {
  if (!PACE[paceName] || regions.length < 2) return [];
  const cuts = [];
  for (let i = 1; i < regions.length; i++) {
    const gap = regions[i].start - regions[i - 1].end;
    if (gap < minGap) continue;
    const start = regions[i - 1].end + 0.15;
    const end = regions[i].start - 0.12;
    if (end - start > 0.1) cuts.push({ kind: "silence", start: round(start), end: round(end), note: `Silence ${gap.toFixed(2)} s` });
  }
  return cuts;
}

// ---------------------------------------------------------------------------
// Mistake candidates: stutters, retakes, false starts, and isolated fillers.
// Mechanical detection only; every candidate is reviewable in the app.
const STOP = new Set("a an and are as at be but by for from i if in is it of on or so that this to was we with you your they their there what when where why how like um uh".split(" "));
const FILLERS = new Set(["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm", "eh"]);

function phraseText(ws) {
  return ws.map((w) => w.text).join(" ");
}

export function segmentWords(words) {
  const segments = [];
  let segStart = 0;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    const gap = cur.start - prev.end;
    const elapsed = cur.end - words[segStart].start;
    if (gap > 0.85 || (SENTENCE_END.test(prev.text) && elapsed >= 2.5) || elapsed >= 16) {
      segments.push({ first: segStart, last: i - 1, start: words[segStart].start, end: prev.end });
      segStart = i;
    }
  }
  if (words.length) segments.push({ first: segStart, last: words.length - 1, start: words[segStart].start, end: words.at(-1).end });
  for (const s of segments) s.text = phraseText(words.slice(s.first, s.last + 1));
  return segments;
}

function signature(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s$%]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)).slice(0, 18);
}
function jaccard(a, b) {
  const as = new Set(a);
  const bs = new Set(b);
  let overlap = 0;
  for (const x of as) if (bs.has(x)) overlap++;
  return overlap / Math.max(1, new Set([...as, ...bs]).size);
}

export function findMistakes(words) {
  const out = [];
  if (!words.length) return out;

  // 1) stutters: the same word twice in a row; cut the first, keep the second.
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1];
    const b = words[i];
    const t = cleanToken(b.text);
    if (t && cleanToken(a.text) === t && b.start - a.end < 0.5) {
      out.push({ kind: "stutter", start: a.start, end: b.start, confidence: "high", recommend: true, removes: a.text, keeps: b.text, note: `Repeated “${t}”` });
    }
  }

  // 2) retakes and false starts between nearby segments; keep the later take.
  const segs = segmentWords(words);
  const sigs = segs.map((s) => signature(s.text));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < Math.min(segs.length, i + 4); j++) {
      if (segs[j].start - segs[i].end > 30) break;
      const score = jaccard(sigs[i], sigs[j]);
      const sameOpening = sigs[i].slice(0, 4).filter((t, k) => t === sigs[j][k]).length >= 2;
      if (score >= 0.34 || (score >= 0.24 && sameOpening)) {
        const falseStart = sameOpening && segs[i].end - segs[i].start < 6 && segs[j].start - segs[i].end < 12;
        out.push({
          kind: falseStart ? "false_start" : "retake",
          start: segs[i].start,
          end: segs[j].start,
          confidence: score >= 0.45 ? "high" : score >= 0.34 ? "medium" : "low",
          recommend: score >= 0.34 && j === i + 1,
          removes: segs[i].text,
          keeps: segs[j].text,
          note: `Similar lines (${Math.round(score * 100)}% match${sameOpening ? ", same opening" : ""})`,
        });
      }
    }
  }

  // 3) fillers: drop only with real silence on both sides (playbook rule).
  for (let i = 0; i < words.length; i++) {
    if (!FILLERS.has(cleanToken(words[i].text))) continue;
    const before = i > 0 ? words[i].start - words[i - 1].end : 1;
    const after = i < words.length - 1 ? words[i + 1].start - words[i].end : 1;
    const isolated = before >= 0.12 && after >= 0.12;
    out.push({
      kind: "filler",
      start: round(words[i].start - Math.min(0.05, before / 2)),
      end: round(words[i].end + Math.min(0.05, after / 2)),
      confidence: isolated ? "high" : "low",
      recommend: isolated,
      removes: words[i].text,
      keeps: "",
      note: isolated ? "Filler with silence on both sides" : "Runs into the next word; cutting may clip it",
    });
  }

  out.sort((a, b) => a.start - b.start);
  // Only one overlapping candidate is on by default; the rest wait for review.
  let lastOnEnd = -1;
  for (const c of out) {
    c.id = `${c.kind}@${c.start.toFixed(2)}`;
    if (c.recommend && c.start < lastOnEnd) c.recommend = false;
    if (c.recommend) lastOnEnd = c.end;
  }
  return out;
}

// Cut range for removing words i..j by hand, splitting the gaps on each side.
export function wordCutRange(words, i, j = i) {
  const before = i > 0 ? words[i].start - words[i - 1].end : 0.12;
  const after = j < words.length - 1 ? words[j + 1].start - words[j].end : 0.12;
  return { start: round(Math.max(0, words[i].start - Math.min(0.06, before / 2))), end: round(words[j].end + Math.min(0.06, after / 2)) };
}

// ---------------------------------------------------------------------------
// Ranges and timeline mapping.
export function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => r.end > r.start).map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push(r);
  }
  return merged;
}

export function keepRanges(cuts, duration) {
  const removed = mergeRanges(cuts.map((c) => ({ start: Math.max(0, c.start), end: Math.min(duration, c.end) })));
  const keeps = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor >= MIN_KEEP) keeps.push({ start: round(cursor), end: round(r.start) });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor >= MIN_KEEP) keeps.push({ start: round(cursor), end: round(duration) });
  return keeps;
}

export function buildTimeline(keeps) {
  let acc = 0;
  return keeps.map((k) => {
    const seg = { start: k.start, end: k.end, outStart: acc };
    acc += k.end - k.start;
    seg.outEnd = acc;
    return seg;
  });
}

export function timelineDuration(timeline) {
  return timeline.length ? timeline.at(-1).outEnd : 0;
}

// Edited time -> source time.
export function srcAt(timeline, t) {
  if (!timeline.length) return 0;
  for (const seg of timeline) if (t < seg.outEnd) return seg.start + Math.max(0, t - seg.outStart);
  const last = timeline.at(-1);
  return last.end;
}

// Source time -> edited time, or null when that moment was cut.
export function outAt(timeline, s) {
  for (const seg of timeline) {
    if (s < seg.start) return null;
    if (s <= seg.end) return seg.outStart + (s - seg.start);
  }
  return null;
}

// Index of the kept segment containing source time s, or of the next one.
export function segmentIndexAt(timeline, s) {
  for (let i = 0; i < timeline.length; i++) if (s < timeline[i].end) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Words on the edited timeline, with per-word edits (text, colour, serif).
export function retimeWords(words, timeline, edits = {}) {
  const out = [];
  words.forEach((w, i) => {
    const e = edits[i] ?? {};
    if (e.cut) return;
    // A word survives if enough of it is kept; it spans its kept pieces.
    let first = null;
    let last = null;
    let kept = 0;
    for (const seg of timeline) {
      const a = Math.max(w.start, seg.start);
      const b = Math.min(w.end, seg.end);
      if (b <= a) continue;
      kept += b - a;
      first ??= seg.outStart + (a - seg.start);
      last = seg.outStart + (b - seg.start);
    }
    if (first === null || kept < Math.min(0.05, (w.end - w.start) * 0.5)) return;
    out.push({ index: i, text: e.text ?? w.text, start: round(first), end: round(last), color: e.color ?? null, serif: !!e.serif });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Captions: 1-3 word chunks split on phrase boundaries. They appear two frames
// before the first word and hold until the next chunk, so they never blink out.
export function chunkCaptions(outWords, { maxWords = 3, maxChars = 18, fps = 30 } = {}) {
  const lead = 2 / fps;
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
  };
  for (let i = 0; i < outWords.length; i++) {
    const w = outWords[i];
    const prev = cur.at(-1);
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || PHRASE_END.test(prev.text) || w.start - prev.end > 0.3 || chars > maxChars)) flush();
    cur.push(w);
  }
  flush();

  return chunks.map((ws, k) => {
    const next = chunks[k + 1];
    const start = Math.max(0, ws[0].start - lead);
    let end = ws.at(-1).end + 0.35;
    if (next && next[0].start - ws.at(-1).end < 0.7) end = Math.max(start + 0.1, next[0].start - lead);
    return {
      start: round(start),
      end: round(end),
      text: ws.map((w) => w.text).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
      color: ws.find((w) => w.color)?.color ?? null,
      serif: ws.some((w) => w.serif),
      words: ws.map((w) => w.index),
    };
  });
}

export function captionAt(captions, t) {
  for (const c of captions) if (t >= c.start && t < c.end) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Shots: zoom levels that alternate on jump cuts (and, in "phrases" mode, at
// phrase boundaries so no shot holds longer than ~2.8 s).
export function computeShots(timeline, outWords, mode = "cuts", { punch = 1.15, maxShot = 2.8 } = {}) {
  const total = timelineDuration(timeline);
  if (!total) return [];
  const bounds = new Set([0]);
  if (mode !== "off") for (const seg of timeline.slice(1)) bounds.add(round(seg.outStart));
  if (mode === "phrases") {
    const candidates = [];
    for (let i = 1; i < outWords.length; i++) {
      const prev = outWords[i - 1];
      if (PHRASE_END.test(prev.text) || outWords[i].start - prev.end >= 0.15) candidates.push(round(outWords[i].start - 0.04));
    }
    const sortedBounds = () => [...bounds].sort((a, b) => a - b);
    let changed = true;
    while (changed) {
      changed = false;
      const b = sortedBounds();
      for (let k = 0; k < b.length; k++) {
        const s = b[k];
        const e = b[k + 1] ?? total;
        if (e - s <= maxShot) continue;
        const inside = candidates.filter((c) => c - s >= 1 && e - c >= 1);
        if (!inside.length) continue;
        const mid = (s + e) / 2;
        bounds.add(inside.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best)));
        changed = true;
        break;
      }
    }
  }
  const b = [...bounds].sort((x, y) => x - y);
  return b.map((s, k) => ({ start: s, end: b[k + 1] ?? total, zoom: mode === "off" || k % 2 === 0 ? 1 : punch }));
}

export function shotAt(shots, t) {
  for (const s of shots) if (t >= s.start && t < s.end) return s;
  return shots.at(-1) ?? { start: 0, end: 0, zoom: 1 };
}

// ---------------------------------------------------------------------------
// Story coach: playbook checks against the edited result.
const CTA = /\b(comment|follow|dm|message|link|save|share|subscribe|click|tap|reply|book|call|visit|join|sign|download|register|order|shop|swipe|check)\b/i;

export function storyChecks({ outWords, timeline, captionsOn, shots, captionY, format = "story", hasTranscript }) {
  const total = timelineDuration(timeline);
  const checks = [];
  const add = (status, title, detail, fix) => checks.push({ status, title, detail, fix });
  const fmt = (s) => `${s.toFixed(1)} s`;

  if (!total) return { score: 0, checks: [{ status: "bad", title: "Nothing left to play", detail: "Every part of the clip is cut. Restore some words." }] };

  if (outWords.length) {
    const first = outWords[0].start;
    if (first <= 0.3) add("good", "Starts talking immediately", `First word at ${fmt(first)}.`);
    else add(first <= 0.7 ? "warn" : "bad", "Slow start", `First word at ${fmt(first)}. Viewers decide in the first second; reels in the house style start speaking within 0.1 s.`, "pace-tight");

    const hookWords = outWords.filter((w) => w.start < 3);
    const hook = hookWords.map((w) => w.text).join(" ") + (hookWords.length < outWords.length && !SENTENCE_END.test(hookWords.at(-1)?.text ?? "") ? "…" : "");
    if (hasTranscript) {
      if (hook.split(/\s+/).length >= 5) add("good", "Hook in the first 3 seconds", `“${hook}” — make it a claim or command that names the tool, person, or result.`);
      else add("warn", "Weak first 3 seconds", `Only “${hook || "silence"}” is said. Lead with the claim; add a hook title if the line is soft.`, "hook");
    }

    let longest = { gap: 0, at: 0 };
    for (let i = 1; i < outWords.length; i++) {
      const gap = outWords[i].start - outWords[i - 1].end;
      if (gap > longest.gap) longest = { gap, at: outWords[i - 1].end };
    }
    if (longest.gap > 0.6) add("warn", "Dead air remains", `A ${fmt(longest.gap)} pause at ${fmt(longest.at)}. Tight pace keeps phrase gaps near 0.2 s.`, "pace-tight");
    else add("good", "No dead air", `Longest pause ${fmt(longest.gap)}.`);

    if (hasTranscript) {
      const speaking = outWords.at(-1).end - outWords[0].start;
      const wps = speaking > 0 ? outWords.length / speaking : 0;
      if (wps >= 2.8) add("good", "Pace", `${wps.toFixed(1)} words per second. Top reels run 4.0 to 4.7.`);
      else add("warn", "Pace feels slow", `${wps.toFixed(1)} words per second. Top reels run 4.0 to 4.7; tighten pauses or cut the setup.`, "pace-tight");

      const lastWords = outWords.filter((w) => w.start >= total - 6).map((w) => w.text).join(" ");
      if (CTA.test(lastWords)) add("good", "Ends with an action", `“${lastWords}”`);
      else add("tip", "No clear call to action", "End on one action: “DM me AUTOMATE”, “Follow for part 2”, “Link in bio”.");
    }

    const tail = total - outWords.at(-1).end;
    if (tail <= 0.5) add("good", "Ends right after the last word", `${fmt(tail)} after the final word.`);
    else add("warn", "Long ending", `${fmt(tail)} of footage after the last word.`, "pace-tight");
  }

  if (format === "story") {
    if (total <= 60) add("good", "Fits one story card", `${fmt(total)} (stories hold up to 60 s each).`);
    else add("warn", "Splits into several story cards", `${fmt(total)} becomes ${Math.ceil(total / 60)} cards. Land the payoff before 60 s or post it as a reel.`);
  }

  if (!hasTranscript) add("warn", "No captions yet", "Transcribe to add word-synced captions; most stories are watched on mute.", "transcribe");
  else if (captionsOn) {
    if (captionY >= 0.15 && captionY <= 0.8) add("good", "Captions on, inside the safe zone", "Most stories play muted; the captions sit clear of the app's top and bottom bars.");
    else add("warn", "Captions under the app's UI", "Move captions between 15% and 80% of the height so the profile row and reply bar do not cover them.", "caption-y");
  } else add("bad", "Captions are off", "Most stories are watched on mute. Turn captions on.", "captions-on");

  const longestShot = shots.reduce((m, s) => Math.max(m, s.end - s.start), 0);
  if (longestShot <= 3.5) add("good", "The frame keeps moving", `Longest unchanged shot ${fmt(longestShot)}.`);
  else add("warn", "Static stretches", `One shot holds ${fmt(longestShot)}. Turn on phrase punch-ins so nothing sits for more than ~3 s.`, "punch-phrases");

  const weights = { good: 1, tip: 0.6, warn: 0.4, bad: 0 };
  const score = Math.round((checks.reduce((n, c) => n + weights[c.status], 0) / checks.length) * 100);
  return { score, checks };
}

// ---------------------------------------------------------------------------
// Exports in the kit's formats so a story can move to the desktop pipeline.
export function toSrt(captions) {
  const ts = (s) => {
    const ms = Math.round(s * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
}

export function kitBundle({ name, duration, cuts, timeline, words, outWords, params }) {
  const total = timelineDuration(timeline);
  return {
    produced_by: "story-studio",
    name,
    edl: {
      agent: "story-studio",
      params,
      source_duration: duration,
      edited_duration: round(total),
      delete_ranges: mergeRanges(cuts),
      keep_ranges: timeline.map((s) => ({ start: s.start, end: s.end })),
      decisions: cuts.map((c) => ({ kind: c.kind, start: c.start, end: c.end, note: c.note ?? "" })),
    },
    source_transcript: words.length ? { audio_duration_secs: duration, words } : null,
    edited_transcript: outWords.length ? { audio_duration_secs: round(total), words: outWords.map((w) => ({ text: w.text, start: w.start, end: w.end, source_index: w.index })) } : null,
  };
}
