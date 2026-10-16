#!/usr/bin/env node
// Serve the Story Studio PWA (app/) locally. No dependencies.
// Usage: node scripts/serve-app.mjs [--port 5180] [--host 0.0.0.0]
// Service workers and installation need a secure context: localhost works; for
// a phone on your Wi-Fi, deploy to HTTPS (see docs/STORY-STUDIO.md).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "app");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt("--port", 5180));
const host = opt("--host", "localhost");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(port, host, () => {
  console.log(`Story Studio: http://localhost:${port}/`);
  if (host === "0.0.0.0") {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) console.log(`On your network: http://${a.address}:${port}/ (no offline mode or install without HTTPS)`);
    }
  }
});
