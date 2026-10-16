import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTranscript,
  silenceCuts,
  findMistakes,
  keepRanges,
  buildTimeline,
  timelineDuration,
  srcAt,
  outAt,
  retimeWords,
  chunkCaptions,
  computeShots,
  speechRegionsFromEnvelope,
  refineWordTimings,
  longSilenceCuts,
  storyChecks,
  wordCutRange,
  toSrt,
} from "../app/js/edit-core.js";

const w = (text, start, end) => ({ text, start, end });

test("normalizes Whisper verbose_json and restores punctuation", () => {
  const t = normalizeTranscript({
    text: " Hello world, this is it.",
    duration: 3,
    words: [{ word: " Hello", start: 0.2, end: 0.5 }, { word: "world", start: 0.55, end: 0.9 }, { word: "this", start: 1.4, end: 1.6 }, { word: "is", start: 1.6, end: 1.7 }, { word: "it", start: 1.7, end: 1.9 }],
  });
  assert.deepEqual(t.words.map((x) => x.text), ["Hello", "world,", "this", "is", "it."]);
  assert.equal(t.duration, 3);
});

test("normalizes ElevenLabs and segment-nested words", () => {
  const eleven = normalizeTranscript({ audio_duration_secs: 2, words: [{ text: "Hi.", start: 0, end: 0.3, type: "word" }, { text: " ", start: 0.3, end: 0.4, type: "spacing" }] });
  assert.equal(eleven.words.length, 1);
  const nested = normalizeTranscript({ segments: [{ text: "Go now.", words: [{ word: "Go", start: 0, end: 0.2 }, { word: "now", start: 0.3, end: 0.5 }] }] });
  assert.deepEqual(nested.words.map((x) => x.text), ["Go", "now."]);
  assert.throws(() => normalizeTranscript({ text: "no timing" }), /word-level/);
});

test("tight pace trims head, tail, and long pauses but keeps a breath", () => {
  const words = [w("First,", 1.0, 1.4), w("cut", 2.5, 2.8), w("this.", 2.85, 3.2)];
  const cuts = silenceCuts(words, 6, "tight");
  const keeps = keepRanges(cuts, 6);
  const tl = buildTimeline(keeps);
  const out = retimeWords(words, tl);
  assert.ok(out[0].start <= 0.1, "speech starts within 0.1 s");
  const beat = out[1].start - out[0].end;
  assert.ok(beat >= 0.2 && beat <= 0.4, `comma beat kept natural (${beat})`);
  assert.ok(timelineDuration(tl) - out.at(-1).end <= 0.3, "ends right after the last word");
  // a cut never starts within 80 ms of the end of the word before it
  for (const c of cuts.filter((x) => x.start > 0)) {
    const before = words.filter((x) => x.end <= c.start).at(-1);
    assert.ok(c.start - before.end >= 0.079, `cut at ${c.start} clips "${before.text}"`);
  }
});

test("pace off makes no cuts", () => {
  assert.deepEqual(silenceCuts([w("a", 1, 2)], 5, "off"), []);
});

test("timeline maps edited time to source and back", () => {
  const tl = buildTimeline([{ start: 1, end: 2 }, { start: 3, end: 5 }]);
  assert.equal(timelineDuration(tl), 3);
  assert.equal(srcAt(tl, 0.5), 1.5);
  assert.equal(srcAt(tl, 1.5), 3.5);
  assert.equal(outAt(tl, 4), 2);
  assert.equal(outAt(tl, 2.5), null);
});

test("finds stutters, retakes, and only isolated fillers", () => {
  const words = [
    w("The", 0, 0.2), w("the", 0.25, 0.4), w("best", 0.45, 0.7), w("way", 0.75, 0.9), w("to", 0.95, 1.0), w("grow.", 1.05, 1.5),
    w("Honestly", 3, 3.4), w("the", 3.45, 3.5), w("best", 3.55, 3.8), w("way", 3.85, 4.0), w("to", 4.05, 4.1), w("grow", 4.15, 4.4), w("revenue.", 4.45, 5.0),
    w("um", 5.4, 5.6), w("and", 5.9, 6.0), w("uh", 6.0, 6.2), w("then.", 6.2, 6.5),
  ];
  const m = findMistakes(words);
  const kinds = m.map((x) => x.kind);
  assert.ok(kinds.includes("stutter"));
  assert.ok(kinds.includes("retake") || kinds.includes("false_start"));
  const fillers = m.filter((x) => x.kind === "filler");
  assert.equal(fillers.length, 2);
  assert.equal(fillers.find((f) => f.removes === "um").recommend, true);
  assert.equal(fillers.find((f) => f.removes === "uh").recommend, false, "filler running into the next word is not cut by default");
  assert.ok(m.every((x) => x.id));
});

test("captions chunk 1-3 words, split on phrases, never blink between close words", () => {
  const words = [w("Stop", 0, 0.2), w("doing", 0.25, 0.5), w("this,", 0.55, 0.8), w("do", 0.9, 1.0), w("that", 1.05, 1.3), w("instead.", 1.35, 1.8)].map((x, i) => ({ ...x, index: i }));
  const caps = chunkCaptions(words, { maxWords: 3 });
  assert.deepEqual(caps.map((c) => c.text), ["Stop doing this,", "do that instead."]);
  assert.ok(caps[0].start <= 0, "appears before the first word");
  assert.ok(Math.abs(caps[0].end - caps[1].start) < 1e-6, "no gap between chunks");
  const single = chunkCaptions(words, { maxWords: 1, maxChars: 30 });
  assert.equal(single.length, 6);
});

test("punch-ins alternate on cuts and split long shots at phrases", () => {
  const tl = buildTimeline([{ start: 0, end: 2 }, { start: 3, end: 9 }]);
  const words = [];
  for (let t = 2.1; t < 7.8; t += 0.5) words.push({ text: words.length % 4 === 3 ? "end." : "word", start: t, end: t + 0.35, index: words.length });
  const cuts = computeShots(tl, words, "cuts");
  assert.deepEqual(cuts.map((s) => s.zoom), [1, 1.15]);
  const phrases = computeShots(tl, words, "phrases");
  assert.ok(phrases.length > 2);
  assert.ok(Math.max(...phrases.map((s) => s.end - s.start)) <= 2.8 + 1e-6);
  assert.equal(computeShots(tl, words, "off").length, 1);
});

test("speech regions from an envelope bridge dips and drop clicks", () => {
  const env = new Float32Array(300).fill(-70);
  env.fill(-20, 50, 120); // 0.5-1.2 s speech
  env.fill(-20, 130, 160); // dip of 0.1 s is bridged
  env[250] = -20; // 10 ms click dropped
  const r = speechRegionsFromEnvelope(env, 0.01);
  assert.equal(r.length, 1);
  assert.equal(r[0].start, 0.5);
  assert.equal(r[0].end, 1.6);
});

test("story checks flag a slow start and missing captions", () => {
  const tl = buildTimeline([{ start: 0, end: 10 }]);
  const outWords = [w("so", 1.5, 1.7), w("yeah.", 1.8, 2.0)].map((x, i) => ({ ...x, index: i }));
  const { checks, score } = storyChecks({ outWords, timeline: tl, captionsOn: false, shots: [{ start: 0, end: 10, zoom: 1 }], captionY: 0.66, format: "story", hasTranscript: true });
  const titles = checks.map((c) => c.title);
  assert.ok(titles.includes("Slow start"));
  assert.ok(titles.includes("Captions are off"));
  assert.ok(score < 60);
});

test("word cuts split the surrounding gaps and SRT formats times", () => {
  const words = [w("a", 0, 0.2), w("b", 0.4, 0.6), w("c", 0.62, 0.8)];
  assert.deepEqual(wordCutRange(words, 1), { start: 0.34, end: 0.61 });
  assert.match(toSrt([{ start: 61.25, end: 62, text: "HI" }]), /00:01:01,250 --> 00:01:02,000\nHI/);
});

test("refines Whisper words that swallow a pause so the pause gets cut", () => {
  // voiced 0-1.0 s, silent 1.0-2.6 s, voiced 2.6-3.2 s
  const env = new Float32Array(320).fill(-70);
  env.fill(-18, 0, 100);
  env.fill(-18, 260, 320);
  const words = [w("less", 0.2, 0.6), w("babysitting.", 0.6, 2.4), w("If", 2.4, 2.9)];
  const refined = refineWordTimings(words, env, 0.01);
  assert.equal(refined.length, 3);
  assert.ok(refined[1].end <= 1.1, `word end pulled in (${refined[1].end})`);
  assert.equal(refined[2].start, 2.4, "a short lead-in is left alone");
  const cuts = silenceCuts(refined, 3.2, "tight");
  assert.ok(cuts.some((c) => c.start < 1.5 && c.end > 2.2), "the swallowed pause is now cut");
  assert.equal(refineWordTimings(words, null), words);
});

test("long silences inside a word's span are still cut, and the word keeps its caption", () => {
  // Whisper says one word spans 0.5-3.0 s, but the audio is silent 1.0-2.5 s.
  const regions = [{ text: "", start: 0.5, end: 1.0 }, { text: "", start: 2.5, end: 3.0 }];
  const cuts = longSilenceCuts(regions, "tight");
  assert.equal(cuts.length, 1);
  assert.deepEqual([cuts[0].start, cuts[0].end], [1.15, 2.38]);
  assert.deepEqual(longSilenceCuts(regions, "off"), []);
  const tl = buildTimeline(keepRanges(cuts, 3));
  const out = retimeWords([w("babysitting.", 0.5, 3.0)], tl);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 0.5);
  assert.ok(Math.abs(out[0].end - (3 - 1.23)) < 1e-6);
});
