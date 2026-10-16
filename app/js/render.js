// Frame compositor shared by the live preview and the MP4 export, so what you
// see is what you post. Caption look follows docs/EDITING-PLAYBOOK.md.
import { captionAt, shotAt } from "./edit-core.js";

export const FORMATS = {
  story: { w: 1080, h: 1920, label: "Story / Reel · 9:16" },
  portrait: { w: 1080, h: 1350, label: "Feed · 4:5" },
  square: { w: 1080, h: 1080, label: "Square · 1:1" },
};

export const ACCENTS = {
  teal: "#2dd4bf",
  red: "#f25555",
  green: "#3ddc84",
  yellow: "#facc15",
};

export const DEFAULT_SETTINGS = {
  pace: "tight",
  format: "story",
  fit: "fill",
  zoom: 1,
  panX: 0,
  panY: 0,
  focusY: 0.38,
  punchMode: "cuts",
  punchZoom: 1.15,
  captions: true,
  captionStyle: "boxed",
  captionWords: 3,
  captionSize: 1,
  captionY: 0.66,
  uppercase: true,
  hookText: "",
  hookSeconds: 3,
  guides: true,
};

const SANS = '"Montserrat", "Arial Black", "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Abril Fatface", Georgia, "Times New Roman", serif';

let blurCanvas = null;

function coverRect(sw, sh, W, H, s) {
  const scale = Math.max(W / sw, H / sh) * s.zoom;
  const w = sw * scale;
  const h = sh * scale;
  const maxX = Math.max(0, (w - W) / 2);
  const maxY = Math.max(0, (h - H) / 2);
  return { x: (W - w) / 2 - s.panX * maxX, y: (H - h) / 2 - s.panY * maxY, w, h };
}

function containRect(sw, sh, W, H, s) {
  const scale = Math.min(W / sw, H / sh) * s.zoom;
  const w = sw * scale;
  const h = sh * scale;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// Scale a rect about an anchor point (the speaker's face height) for punch-ins.
function punch(rect, zoom, ax, ay) {
  if (zoom === 1) return rect;
  return { x: ax - (ax - rect.x) * zoom, y: ay - (ay - rect.y) * zoom, w: rect.w * zoom, h: rect.h * zoom };
}

function drawBlurredBackground(ctx, src, sw, sh, W, H) {
  // Downscale then upscale: a cheap blur that works in every browser.
  const bw = 36;
  const bh = Math.round((bw * H) / W);
  if (!blurCanvas) blurCanvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bw, bh) : Object.assign(document.createElement("canvas"), { width: bw, height: bh });
  if (blurCanvas.width !== bw || blurCanvas.height !== bh) {
    blurCanvas.width = bw;
    blurCanvas.height = bh;
  }
  const b = blurCanvas.getContext("2d");
  const r = coverRect(sw, sh, bw, bh, { zoom: 1.1, panX: 0, panY: 0 });
  b.drawImage(src, r.x, r.y, r.w, r.h);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(blurCanvas, 0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx, text, maxWidth, maxLines = 2) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).join(" "));
    return head;
  }
  return lines;
}

function fitFont(ctx, lines, family, weight, size, maxWidth) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width));
  while (s > 24 && widest() > maxWidth) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

function drawCaption(ctx, W, H, cap, s) {
  const style = s.captionStyle;
  const single = style === "word";
  const base = (single ? 50 : 62) * s.captionSize * (W / 1080);
  const family = cap.serif ? SERIF : SANS;
  const weight = cap.serif ? 400 : 800;
  const text = s.uppercase && !cap.serif ? cap.text.toUpperCase() : cap.text;
  const maxWidth = W * 0.84;
  ctx.font = `${weight} ${base}px ${family}`;
  let lines = wrapLines(ctx, text, maxWidth, 2);
  const size = fitFont(ctx, lines, family, weight, base, maxWidth);
  lines = wrapLines(ctx, text, maxWidth, 2);
  const lineH = size * 1.12;
  const cx = W / 2;
  const cy = H * s.captionY;
  const color = cap.color ? ACCENTS[cap.color] : "#ffffff";

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  if (style === "boxed") {
    const padX = size * 0.42;
    const padY = size * 0.26;
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = textW + padX * 2;
    const boxH = lines.length * lineH + padY * 2;
    const x = cx - boxW / 2;
    const y = cy - boxH / 2;
    roundRect(ctx, x, y, boxW, boxH, size * 0.22);
    ctx.fillStyle = "rgba(14,14,18,0.88)";
    ctx.fill();
    ctx.lineWidth = Math.max(2, size * 0.035);
    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.stroke();
  }

  lines.forEach((line, k) => {
    const y = cy + (k - (lines.length - 1) / 2) * lineH + size * 0.04;
    if (style !== "boxed") {
      ctx.lineWidth = size * 0.18;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = size * 0.25;
      ctx.strokeText(line, cx, y);
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = color;
    ctx.fillText(line, cx, y);
  });
  ctx.restore();
}

function drawHook(ctx, W, H, text) {
  const size = 58 * (W / 1080);
  const maxWidth = W * 0.8;
  ctx.save();
  ctx.font = `800 ${size}px ${SANS}`;
  const lines = wrapLines(ctx, text.toUpperCase(), maxWidth, 3);
  const fs = fitFont(ctx, lines, SANS, 800, size, maxWidth);
  const lineH = fs * 1.15;
  const padX = fs * 0.5;
  const padY = fs * 0.32;
  const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textW + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const x = (W - boxW) / 2;
  const y = H * 0.17;
  roundRect(ctx, x, y, boxW, boxH, fs * 0.24);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.fillStyle = "#101014";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, k) => ctx.fillText(line, W / 2, y + padY + lineH * (k + 0.5) + fs * 0.04));
  ctx.restore();
}

function drawGuides(ctx, W, H, s) {
  if (s.format !== "story") return;
  ctx.save();
  ctx.fillStyle = "rgba(255, 80, 80, 0.16)";
  ctx.fillRect(0, 0, W, H * 0.13);
  ctx.fillRect(0, H * 0.82, W, H * 0.18);
  ctx.setLineDash([12, 10]);
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, H * 0.13);
  ctx.lineTo(W, H * 0.13);
  ctx.moveTo(0, H * 0.82);
  ctx.lineTo(W, H * 0.82);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw one output frame.
 * @param ctx 2D context of a W x H canvas
 * @param src video element, canvas, or image holding the source frame (or null)
 * @param sw,sh source display size
 * @param t time on the edited timeline in seconds
 * @param model { settings, captions, shots }
 * @param preview draw safe-zone guides when true
 */
export function drawFrame(ctx, W, H, src, sw, sh, t, model, preview = false) {
  const s = model.settings;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (src && sw && sh) {
    const shot = shotAt(model.shots, t);
    const base = s.fit === "fit" ? containRect(sw, sh, W, H, s) : coverRect(sw, sh, W, H, s);
    const anchorY = s.fit === "fit" ? H / 2 : base.y + base.h * s.focusY;
    const r = punch(base, shot.zoom, W / 2, anchorY);
    if (s.fit === "fit") drawBlurredBackground(ctx, src, sw, sh, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
  }
  if (s.hookText && t < s.hookSeconds) drawHook(ctx, W, H, s.hookText);
  if (s.captions) {
    const cap = captionAt(model.captions, t);
    if (cap) drawCaption(ctx, W, H, cap, s);
  }
  if (preview && s.guides) drawGuides(ctx, W, H, s);
}

export async function loadFonts() {
  if (!document.fonts?.load) return;
  await Promise.allSettled([document.fonts.load(`800 64px "Montserrat"`), document.fonts.load(`400 64px "Abril Fatface"`)]);
}
