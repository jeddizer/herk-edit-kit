// Draws one recap frame. Shared by the live preview and the export so they match.
import { cropRect, segmentAt, pipStateAt, ease } from "./recap-core.js";

const TEXT_FONT = '"Inter", -apple-system, "Helvetica Neue", Arial, sans-serif';

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = word;
      } else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

// Instagram-style text: each line in its own white rounded box, dark text, centred.
function drawTextBlock(ctx, W, H, block, alpha) {
  const k = W / 1080;
  const size = 54 * k;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `650 ${size}px ${TEXT_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineH = size * 1.32;
  const padX = 22 * k;
  const groups = block.lines.map((l) => wrap(ctx, l, W * 0.84));
  const gap = 34 * k;
  const height = groups.reduce((h, g) => h + g.length * lineH, 0) + gap * (groups.length - 1);
  let y = block.place === "hook" ? Math.max(H * 0.2, H * 0.36 - height / 2) : H * 0.156;
  for (const g of groups) {
    for (const line of g) {
      const w = ctx.measureText(line).width + padX * 2;
      roundRectPath(ctx, (W - w) / 2, y, w, lineH, 14 * k);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.fillStyle = "#111111";
      ctx.fillText(line, W / 2, y + lineH / 2 + size * 0.03);
      y += lineH;
    }
    y += gap;
  }
  ctx.restore();
}

function drawPip(ctx, W, H, src, sw, sh, slide) {
  const k = W / 1080;
  const pw = 380 * k;
  const ph = (pw * sh) / sw;
  const margin = 44 * k;
  const x0 = W - pw - margin;
  const x = x0 + (W - x0 + 40 * k) * (1 - slide);
  const y = Math.min(H * 0.385, H * 0.8 - ph);
  const r = 34 * k;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 36 * k;
  ctx.shadowOffsetY = 8 * k;
  roundRectPath(ctx, x - 6 * k, y - 6 * k, pw + 12 * k, ph + 12 * k, r + 6 * k);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRectPath(ctx, x, y, pw, ph, r);
  ctx.clip();
  ctx.drawImage(src, x, y, pw, ph);
  ctx.restore();
}

function drawLogo(ctx, W, H, logo, alpha) {
  const k = W / 1080;
  const lw = 420 * k;
  const lh = (lw * logo.height) / logo.width;
  const padX = 26 * k;
  const padY = 16 * k;
  const y = H * 0.8125;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRectPath(ctx, (W - lw) / 2 - padX, y, lw + padX * 2, lh + padY * 2, 18 * k);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.drawImage(logo, (W - lw) / 2, y + padY, lw, lh);
  ctx.restore();
}

function drawShot(ctx, W, H, seg, p, shot) {
  if (!shot?.img || !shot.w || !shot.h) return;
  const r = cropRect(seg.move, p, shot.w, shot.h, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(shot.img, r.x, r.y, r.w, r.h, 0, 0, W, H);
}

// Before/after divider: a white line with a round handle, like a comparison slider.
function drawDivider(ctx, W, H, x) {
  const k = W / 1080;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 18 * k;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 4 * k, 0, 8 * k, H);
  ctx.beginPath();
  ctx.arc(x, H / 2, 40 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.fillStyle = "#111111";
  const a = 11 * k;
  for (const d of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + d * 8 * k, H / 2 - a);
    ctx.lineTo(x + d * (8 * k + a * 1.2), H / 2);
    ctx.lineTo(x + d * 8 * k, H / 2 + a);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * @param sources.shot(segment, t) -> { img, w, h } | null   frame for the current shot
 * @param sources.pip(srcTime) -> { img, w, h } | null       screen-recording frame
 * @param sources.prev(segment) -> { img, w, h } | null      last frame of a before shot (defaults to shot)
 * @param sources.logo ImageBitmap | null
 */
export function drawRecapFrame(ctx, W, H, plan, t, sources, opts = {}) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!plan.segments.length) return;
  const seg = segmentAt(plan, t);
  const shot = sources.shot(seg, t);
  const p = (t - seg.start) / Math.max(0.001, seg.end - seg.start);
  if (seg.wipe && t < seg.start + seg.wipe.dur && seg.index > 0) {
    // The after shot is revealed from the left as the divider sweeps across the before shot.
    const prev = plan.segments[seg.index - 1];
    drawShot(ctx, W, H, prev, 1, (sources.prev ?? sources.shot)(prev, t));
    const x = W * ease(Math.min(1, Math.max(0, (t - seg.start) / seg.wipe.dur)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, H);
    ctx.clip();
    drawShot(ctx, W, H, seg, p, shot);
    ctx.restore();
    drawDivider(ctx, W, H, x);
  } else drawShot(ctx, W, H, seg, p, shot);
  const pip = pipStateAt(plan.pip, t);
  if (pip) {
    const f = sources.pip?.(pip.src);
    if (f?.img) drawPip(ctx, W, H, f.img, f.w, f.h, pip.slide);
  }
  for (const block of plan.texts) {
    // Text on the very first frame shows at full strength: it is the thumbnail.
    if (t >= block.start && t < block.end) drawTextBlock(ctx, W, H, block, block.start === 0 ? 1 : Math.min(1, (t - block.start) / 0.12));
  }
  if (plan.endAt !== null && t >= plan.endAt && sources.logo && opts.showLogo !== false) {
    drawLogo(ctx, W, H, sources.logo, Math.min(1, (t - plan.endAt) / 0.12));
  }
  if (opts.guides) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 80, 80, 0.14)";
    ctx.fillRect(0, 0, W, H * 0.13);
    ctx.fillRect(0, H * 0.82, W, H * 0.18);
    ctx.restore();
  }
}
