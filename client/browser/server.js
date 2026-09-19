// Minimal static file server for `client/`, on an ephemeral port, for `pass.js` to point the
// browser at. Deliberately its own thing rather than importing `src/edge/http-common` — that
// module is compiled by tsc into `dist/`, and `client/` is otherwise never touched by the
// TypeScript build (`tsconfig.json`'s `include` is `src/**/*.ts` only); reusing it here would
// wire `client/`'s test harness through the build it is currently independent of.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT_DIR = fileURLToPath(new URL('../', import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function contentTypeFor(path) {
  const dot = path.lastIndexOf('.');
  return CONTENT_TYPES[path.slice(dot)] ?? 'application/octet-stream';
}

/** Starts the static server and resolves with { origin, close() } once it is listening. */
export function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = normalize(join(CLIENT_DIR, requestedPath));
    if (!resolved.startsWith(normalize(CLIENT_DIR + sep)) && resolved !== normalize(CLIENT_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(resolved);
      res.writeHead(200, { 'content-type': contentTypeFor(resolved) }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
