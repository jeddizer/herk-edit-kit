import test from "node:test";
import assert from "node:assert/strict";
import { planRecap, motionKeepRanges, pipStateAt, cropRect, moveFor, END_HOLD } from "../app/js/recap-core.js";
import { renderMusic, musicToWav, SR } from "../app/js/music.js";

const photo = (n, w = 1512, h = 2016) => ({ id: `p${n}`, kind: "photo", width: w, height: h, text: "" });
const clip = (n, duration, trimIn = 0, trimOut = 3) => ({ id: `v${n}`, kind: "video", width: 1080, height: 1920, duration, trimIn, trimOut, text: "" });

test("shots land on the 120 BPM beat, with the opening and ending held", () => {
  const items = [photo(1), photo(2), clip(3, 10, 1, 3.7), photo(4)];
  const plan = planRecap(items, { hook1: "3 days before the event…", hook2: "Can we do it?", endText: "We just did.", showLogo: true }, 0);
  for (const s of plan.segments) {
    assert.equal((s.start * 2) % 1, 0, `cut at ${s.start} is on the beat`);
  }
  assert.equal(plan.segments[0].end, 6, "two-line opening holds 6 s");
  assert.equal(plan.segments[2].end - plan.segments[2].start, 2.5, "clip length snaps to the beat");
  assert.equal(plan.segments[2].srcIn, 1);
  assert.equal(plan.endAt, plan.total - END_HOLD);
  const end = plan.texts.at(-1);
  assert.deepEqual(end.lines, ["We just did."]);
  assert.equal(plan.music.drop, 6, "the beat drops on the first cut after the opening");
  assert.equal(plan.music.hit, plan.endAt);
});

test("text appears only where the owner wrote it: no automatic labels", () => {
  const items = [photo(1), { ...photo(2), text: "self check-in kiosks" }, photo(3)];
  const plan = planRecap(items, { endText: "", showLogo: false }, 0);
  assert.equal(plan.texts.length, 1);
  assert.deepEqual(plan.texts[0].lines, ["self check-in kiosks"]);
  assert.equal(plan.endAt, null);
});

test("fits the length limit by shortening photos, then warns instead of dropping shots", () => {
  const items = Array.from({ length: 10 }, (_, i) => photo(i));
  const fit = planRecap(items, { endText: "We just did." }, 30);
  assert.ok(fit.total <= 30, `fits: ${fit.total}`);
  assert.equal(fit.segments.length, 10);
  const many = planRecap(Array.from({ length: 30 }, (_, i) => photo(i)), {}, 30);
  assert.ok(many.total > 30);
  assert.match(many.warnings.join(" "), /over your 30 s limit/);
});

test("screen recording rides beside the chosen shots and leaves as the ending lands", () => {
  const items = Array.from({ length: 6 }, (_, i) => photo(i));
  const keep = [{ start: 2.8, end: 3.5 }, { start: 4.6, end: 6.2 }, { start: 13, end: 20 }];
  const plan = planRecap(items, { endText: "We just did.", pip: { duration: 27.8, keep, cutPauses: true, from: 3, to: 5 } }, 0);
  assert.equal(plan.pip.start, plan.segments[3].start);
  assert.equal(plan.pip.end, plan.endAt);
  const s0 = pipStateAt(plan.pip, plan.pip.start + 0.5);
  assert.ok(Math.abs(s0.src - (2.8 + 0.5)) < 1e-6, "starts at the first kept moment");
  const s1 = pipStateAt(plan.pip, plan.pip.start + 1.0);
  assert.ok(Math.abs(s1.src - (4.6 + 0.3)) < 1e-6, "jumps over the cut pause");
  assert.equal(pipStateAt(plan.pip, plan.endAt + 1), null);
  assert.equal(plan.music.whoosh[0], plan.pip.start);
});

test("long still stretches in a recording are cut down to a short hold", () => {
  const rate = 10;
  const diffs = [999];
  const push = (n, v) => { for (let i = 0; i < n; i++) diffs.push(v); };
  push(24, 0.1); // 2.4 s splash
  push(10, 6); // 1 s of motion
  push(44, 0.2); // 4.4 s spinner
  push(20, 5); // 2 s of motion
  push(3, 0.1); // short pause kept
  push(10, 5);
  const keep = motionKeepRanges(diffs, rate, { duration: diffs.length / rate });
  const total = keep.reduce((a, k) => a + k.end - k.start, 0);
  assert.ok(total < 5.5 && total > 4, `kept ${total.toFixed(2)} s of ${diffs.length / rate} s`);
  assert.ok(keep[0].start >= 2.3 && keep[0].start <= 2.5, `still opening dropped entirely (${keep[0].start})`);
});

test("camera moves alternate, pan landscape shots, and pull back on the last shot", () => {
  const a = moveFor(photo(0), 0, false);
  const b = moveFor(photo(1), 1, false);
  assert.notDeepEqual(a, b);
  const land = moveFor(photo(2, 2016, 1512), 2, false);
  assert.notEqual(land.cx0, land.cx1);
  const last = moveFor(photo(3), 3, true);
  assert.ok(last.z0 > last.z1);
  const r = cropRect(land, 0, 2016, 1512, 1080, 1920);
  assert.ok(r.x >= 0 && r.x + r.w <= 2016 + 1e-6 && Math.abs(r.w / r.h - 1080 / 1920) < 1e-6);
});

test("music renders the planned length, leveled and never clipping", () => {
  const plan = planRecap([photo(1), photo(2), photo(3)], { hook1: "Line", endText: "Done." }, 0);
  const m = renderMusic({ ...plan.music, seed: 3 });
  assert.equal(m.left.length, Math.ceil(plan.total * SR));
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < m.left.length; i++) {
    peak = Math.max(peak, Math.abs(m.left[i]), Math.abs(m.right[i]));
    sum += m.left[i] ** 2;
  }
  const rms = Math.sqrt(sum / m.left.length);
  assert.ok(peak <= 0.85, `peak ${peak}`);
  assert.ok(rms > 0.05, `audible: rms ${rms}`);
  assert.equal(musicToWav(m).byteLength, 44 + m.left.length * 4);
});

test("a recording can skip its first seconds", () => {
  const items = Array.from({ length: 4 }, (_, i) => photo(i));
  const keep = [{ start: 0, end: 5 }, { start: 8, end: 12 }];
  const plan = planRecap(items, { pip: { duration: 12, keep, cutPauses: true, trimStart: 3, from: 0, to: 3 } }, 0);
  assert.equal(plan.pip.content, 6);
  assert.ok(Math.abs(pipStateAt(plan.pip, 0.5).src - 3.5) < 1e-6);
});

test("a long screen recording plays in full: the shots beside it stretch instead", () => {
  const items = Array.from({ length: 6 }, (_, i) => photo(i));
  const plan = planRecap(items, { endText: "Done.", pip: { duration: 40, keep: [{ start: 0, end: 12 }], cutPauses: false, from: 2, to: 5 } }, 30);
  assert.equal(plan.pip.content, 40, "uses the whole recording when pauses are not cut");
  assert.ok(plan.pip.end - plan.pip.start >= 40, `window ${plan.pip.end - plan.pip.start}`);
  for (const s of plan.segments) assert.equal((s.start * 2) % 1, 0, "still on the beat");
  assert.ok(!plan.warnings.some((w) => /Only the first/.test(w)));
  assert.match(plan.warnings.join(" "), /full screen recording makes this story .* over your 30 s limit/, "explains why it runs past the limit");
  assert.ok(!plan.warnings.some((w) => /holds its last frame/.test(w)), "no warning for beat rounding");
  const cut = planRecap(items, { endText: "Done.", pip: { duration: 40, keep: [{ start: 0, end: 12 }], cutPauses: true, from: 2, to: 5 } }, 30);
  assert.equal(cut.pip.content, 12, "pause-cutting is the owner's choice");
});
