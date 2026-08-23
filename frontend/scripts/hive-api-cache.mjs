/**
 * ════ A CACHING PROXY FOR THE HIVE API, FOR TEST RUNS ONLY ════
 *
 * ★★★ WHY THIS EXISTS: THE E2E SUITE WAS NOT DETERMINISTIC, AND THIS IS WHY.
 *
 * Measured 2026-08-21. `postContentOrder.spec.ts` — a file nobody had touched —
 * produced 0, 8, 2 and 1 failures across four consecutive runs. Every one of those
 * failures was a 60s timeout, never a wrong value. One `comments.spec.ts` test that
 * times out at 60s under three workers passes ALONE in 3.9 seconds.
 *
 * The cause is upstream latency, not the app. Serving one fixture post:
 *
 *     /hive-160391/@gtg/hive-hardfork-25-jump-starter-kit   11.8s, 8.4s, 8.5s, 8.6s
 *     /moviereviews/@hanshotfirst/a-geeky-guy-s-guide-…      3.2s
 *
 * Consistently ~8.5s, with no caching anywhere: every render re-fetches the post,
 * its 40+ comment discussion, the community and the follow list from the live
 * `api.hive.blog`. Three parallel workers all doing that against the same heavy
 * fixture is what blows the 60s test timeout — and because it depends on someone
 * else's server, the failure count moves between runs with no code change. A suite
 * that swings 26 failures on identical code cannot gate anything.
 *
 * ★ WHAT THIS DOES: sits between the app and `api.hive.blog`, caching every
 * read response on disk keyed by the exact request body. First run pays the real
 * latency once per distinct call; every run after that is served locally.
 *
 * ★ WHY IT IS NOT A MOCK, AND THE DISTINCTION MATTERS. It never invents a
 * response and never edits one. Every byte it returns was served by the real Hive
 * API for that exact request. It changes WHEN the data was fetched, not WHAT the
 * data is — so a test still asserts against real chain content, which is the whole
 * point of these fixtures. Delete `.hive-api-cache/` to re-fetch from live.
 *
 * ★ WRITES ARE NEVER CACHED. Anything that could mutate chain state
 * (`broadcast`, `*_transaction`) is passed straight through, uncached, every time.
 *
 * ★ HTTPS, because the app is served over TLS for these runs (auth cookies are
 * `Secure`), and a page on https may not fetch an http endpoint — the browser
 * blocks it as mixed content. Reuses the same self-signed cert as
 * `lumen-https-front.mjs`.
 *
 * Usage:
 *   node scripts/hive-api-cache.mjs &
 *   REACT_APP_API_ENDPOINT=https://localhost:3445 NEXT_DIST_DIR=.next-qa pnpm start
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.HIVE_CACHE_PORT || 3445);
const UPSTREAM = process.env.HIVE_CACHE_UPSTREAM || 'https://api.hive.blog';
const CERT_DIR = process.env.LUMEN_TLS_DIR || path.join(process.cwd(), '.tls');
const CACHE_DIR = process.env.HIVE_CACHE_DIR || path.join(process.cwd(), '.hive-api-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const NEVER_CACHE = /broadcast|_transaction|login|signup/i;
let hits = 0;
let misses = 0;
let passthrough = 0;

const keyFor = (method, url, body) =>
  crypto.createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex').slice(0, 40);

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const forward = (method, url, body, headers) =>
  new Promise((resolve, reject) => {
    const u = new URL(url, UPSTREAM);
    const r = https.request(
      { hostname: u.hostname, port: 443, path: u.pathname + u.search, method,
        headers: { 'content-type': 'application/json', accept: 'application/json',
                   'content-length': Buffer.byteLength(body || '') } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 502, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });

const opts = {
  key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem'))
};

https
  .createServer(opts, async (req, res) => {
    const body = await readBody(req);
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(payload);
    };

    if (NEVER_CACHE.test(body)) {
      passthrough++;
      try {
        const up = await forward(req.method, req.url, body, req.headers);
        return send(up.status, up.body);
      } catch (e) {
        return send(502, JSON.stringify({ error: 'proxy: ' + e.message }));
      }
    }

    const file = path.join(CACHE_DIR, keyFor(req.method, req.url, body) + '.json');
    if (fs.existsSync(file)) {
      hits++;
      return send(200, fs.readFileSync(file, 'utf8'));
    }

    try {
      const up = await forward(req.method, req.url, body, req.headers);
      // Only a clean 200 with parseable JSON and no rpc-level error is worth keeping;
      // caching a failure would freeze a transient upstream blip into every later run.
      let cacheable = up.status === 200;
      if (cacheable) {
        try {
          const j = JSON.parse(up.body);
          if (j && j.error) cacheable = false;
        } catch { cacheable = false; }
      }
      if (cacheable) fs.writeFileSync(file, up.body);
      misses++;
      return send(up.status, up.body);
    } catch (e) {
      return send(502, JSON.stringify({ error: 'proxy: ' + e.message }));
    }
  })
  .listen(PORT, () => {
    console.log(`hive-api-cache: https://localhost:${PORT} -> ${UPSTREAM}, cache ${CACHE_DIR}`);
  });

setInterval(() => {
  if (hits || misses || passthrough)
    console.log(`  cache: ${hits} hits, ${misses} misses, ${passthrough} passthrough`);
}, 30000).unref?.();
