// Minimal static dev server — Node stdlib only, no dependencies.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const file = resolve(join(ROOT, pathname));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');

    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) return send(res, 404, 'Not found');

    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, String(err));
  }
}).listen(PORT, () => {
  console.log(`Nansen Aquarium → http://localhost:${PORT}`);
});
