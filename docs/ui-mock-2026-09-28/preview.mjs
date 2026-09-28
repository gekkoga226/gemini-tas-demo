// Serves this folder for review: node docs/ui-mock-2026-09-28/preview.mjs [port]  (default 4186)
// The mock also opens directly from the file (index.html). 4173 (real connection) and 4176 (09-21 mock) are not used.
// Avoid ports that browsers block (for example 4190).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 4186);
if (!Number.isInteger(port) || port <= 0 || [4173, 4176].includes(port)) {
  console.error('4173番と4176番以外のポートを指定してください。');
  process.exit(2);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`UI mock: http://127.0.0.1:${port}/`));
