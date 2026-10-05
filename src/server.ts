import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard: three static files and a JSON state endpoint, plus a
// Server-Sent Events stream that pushes the same JSON once a second.
// Binds to 127.0.0.1 unless HOST says otherwise.

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

export function serve(host: string, port: number, state: () => unknown, mode: () => unknown): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = FILES[url.pathname];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (file) {
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
      res.end(readFileSync(join(PUBLIC, file[0])));
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ mode: mode(), ...(state() as object) }));
      return;
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const push = () => res.write(`data: ${JSON.stringify({ mode: mode(), ...(state() as object) })}\n\n`);
      push();
      const timer = setInterval(push, 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  server.listen(port, host);
  return server;
}
