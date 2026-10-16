// scripts/serve-static.mjs — a static server that serves a built copy the way GitHub Pages does: a .gz file as
// application/gzip without Content-Encoding (the app inflates it itself), a directory as its index.html, nothing cached.
//   node scripts/serve-static.mjs [dir=public-copy] [port=8123]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', wasm: 'application/wasm',
  gz: 'application/gzip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', bin: 'application/octet-stream', glb: 'model/gltf-binary',
};

/** Serves `dir` on http://host:port; resolves with the server once it listens. */
export function serve(dir, port = 8123, host = '127.0.0.1') {
  dir = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.normalize(path.join(dir, p));
    if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
    let st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }).end(); return; }
      file = path.join(file, 'index.html');
      st = fs.statSync(file, { throwIfNoEntry: false });
    }
    if (!st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(port, host, () => resolve(server)); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await serve(process.argv[2] || 'public-copy', +(process.argv[3] || 8123));
  console.log(`serving at http://127.0.0.1:${s.address().port}/`);
}
