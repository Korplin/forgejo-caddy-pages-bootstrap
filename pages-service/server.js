'use strict';
// Pages service: serves every repo of ONE Forgejo user as a static website.
//   GET /<repo>/<path>  ->  Forgejo API raw file of <PAGES_OWNER>/<repo>, branch <PAGES_BRANCH>
// No dependencies, Node 18+ (global fetch).

const http = require('node:http');

const cfg = {
  port: Number(process.env.PORT || 8080),
  forgejoUrl: (process.env.FORGEJO_URL || 'http://forgejo:3000').replace(/\/+$/, ''),
  owner: process.env.PAGES_OWNER || '',
  branch: process.env.PAGES_BRANCH || 'main',
  token: process.env.FORGEJO_TOKEN || '', // optional, only needed for private repos
  cacheTtlMs: Number(process.env.CACHE_TTL_MS || 30000),
  missTtlMs: Number(process.env.MISS_TTL_MS || 5000),
  browserMaxAge: Number(process.env.BROWSER_MAX_AGE_SECONDS || 30),
  cacheMaxBytes: Number(process.env.CACHE_MAX_BYTES || 128 * 1024 * 1024),
  cacheMaxFileBytes: Number(process.env.CACHE_MAX_FILE_BYTES || 5 * 1024 * 1024),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 10000),
};

if (!cfg.owner) {
  console.error('PAGES_OWNER is required');
  process.exit(1);
}

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

function mimeFor(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

// ---- cache (in-memory, TTL based, oldest-first eviction) --------------------
const cache = new Map(); // key -> { status, body, expires, size }
const inflight = new Map(); // key -> Promise
let cacheBytes = 0;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expires < Date.now()) {
    cache.delete(key);
    cacheBytes -= e.size;
    return null;
  }
  return e;
}

function cacheSet(key, entry) {
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cacheBytes -= old.size;
  }
  cache.set(key, entry);
  cacheBytes += entry.size;
  for (const [k, v] of cache) {
    if (cacheBytes <= cfg.cacheMaxBytes) break;
    cache.delete(k);
    cacheBytes -= v.size;
  }
}

// ---- Forgejo access ----------------------------------------------------------
function rawUrl(repo, filePath) {
  const encPath = filePath.split('/').map(encodeURIComponent).join('/');
  return (
    `${cfg.forgejoUrl}/api/v1/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repo)}` +
    `/raw/${encPath}?ref=${encodeURIComponent(cfg.branch)}`
  );
}

async function loadFromForgejo(repo, filePath) {
  const headers = {};
  if (cfg.token) headers.Authorization = `token ${cfg.token}`;
  const r = await fetch(rawUrl(repo, filePath), {
    headers,
    signal: AbortSignal.timeout(cfg.fetchTimeoutMs),
  });
  if (r.status >= 500) throw new Error(`Forgejo answered ${r.status}`);
  if (r.status >= 400) return { status: 404, body: null, size: 0, expires: Date.now() + cfg.missTtlMs };
  const body = Buffer.from(await r.arrayBuffer());
  return { status: 200, body, size: body.length, expires: Date.now() + cfg.cacheTtlMs };
}

// Returns { status: 200|404, body }. Throws when Forgejo is unreachable or broken.
async function getFile(repo, filePath) {
  const key = `${repo}/${filePath}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let p = inflight.get(key);
  if (!p) {
    p = loadFromForgejo(repo, filePath)
      .then((entry) => {
        if (entry.size <= cfg.cacheMaxFileBytes) cacheSet(key, entry);
        return entry;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// ---- HTTP --------------------------------------------------------------------
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function reply(req, res, status, headers, body) {
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function text(req, res, status, message) {
  reply(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, message + '\n');
}

function sendFile(req, res, status, filePath, body) {
  reply(
    req,
    res,
    status,
    {
      'Content-Type': mimeFor(filePath),
      'Cache-Control': status === 200 ? `public, max-age=${cfg.browserMaxAge}` : 'no-store',
    },
    body
  );
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return text(req, res, 405, 'Method not allowed');
  }

  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://pages.local');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return text(req, res, 400, 'Bad request');
  }

  if (pathname === '/healthz') return text(req, res, 200, 'ok');
  if (pathname === '/') return text(req, res, 200, `Pages service. Use /<repo>/ (owner: ${cfg.owner}, branch: ${cfg.branch}).`);
  if (pathname.includes('\0') || pathname.includes('\\')) return text(req, res, 400, 'Bad request');

  const segs = pathname.slice(1).split('/');
  const bad = segs.some((s, i) => s === '.' || s === '..' || (s === '' && i !== segs.length - 1));
  const repo = segs[0];
  if (bad || !REPO_RE.test(repo)) return text(req, res, 404, 'Not found');

  // /repo  ->  /repo/   (needed so relative asset links resolve inside the repo folder)
  if (segs.length === 1) {
    return reply(req, res, 301, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'no-store' }, '');
  }

  const trailingSlash = segs[segs.length - 1] === '';
  const rel = segs.slice(1).filter((s) => s !== '').join('/');
  let target;
  if (trailingSlash || rel === '') target = rel ? `${rel}/index.html` : 'index.html';
  else target = rel;

  let file = await getFile(repo, target);

  // /repo/about  ->  /repo/about/   when about/index.html exists
  if (file.status === 404 && !trailingSlash && rel !== '') {
    const dirIndex = await getFile(repo, `${rel}/index.html`);
    if (dirIndex.status === 200) {
      return reply(req, res, 301, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'no-store' }, '');
    }
  }

  if (file.status === 200) return sendFile(req, res, 200, target, file.body);

  // Custom 404 page of the repo, like GitHub Pages
  const custom = await getFile(repo, '404.html');
  if (custom.status === 200) return sendFile(req, res, 404, '404.html', custom.body);
  return text(req, res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - started}ms`);
  });
  handle(req, res).catch((err) => {
    console.error(`error for ${req.url}: ${err.message}`);
    if (!res.headersSent) text(req, res, 502, 'Bad gateway: Forgejo is not reachable');
    else res.destroy();
  });
});

server.listen(cfg.port, () => {
  console.log(`pages-service listening on :${cfg.port}, owner=${cfg.owner}, branch=${cfg.branch}, forgejo=${cfg.forgejoUrl}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
