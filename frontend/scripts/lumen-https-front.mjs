/**
 * Minimal HTTPS terminator in front of the production Next server.
 *
 * ★★★ WHY THIS IS NOT OPTIONAL FOR QA.
 *
 * With NODE_ENV=production the session cookie is issued `Secure`. A browser
 * talking plain http:// accepts that cookie and then never sends it back, so
 * every authenticated request arrives anonymous — which on screen is
 * indistinguishable from "login is broken". A production QA pass over http://
 * therefore cannot verify ANYTHING behind a login, and worse, it invents
 * failures that do not exist. This terminates TLS on :3443 and forwards to the
 * Next server on :3000, so the cookie behaves exactly as it will in production.
 *
 *   1. Generate a cert once (self-signed, 30 days):
 *        mkdir -p .tls && openssl req -x509 -newkey rsa:2048 -nodes \
 *          -keyout .tls/key.pem -out .tls/cert.pem -days 30 \
 *          -subj "/CN=localhost" \
 *          -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
 *   2. Start the production server on :3000, then:
 *        node scripts/lumen-https-front.mjs &
 *   3. Point tooling at https://localhost:3443. For node's own `fetch`:
 *        NODE_EXTRA_CA_CERTS=$PWD/.tls/cert.pem node qa-auth-https.mjs
 *      (NOT NODE_TLS_REJECT_UNAUTHORIZED=0 — that disables verification for the
 *      whole process, so a run could no longer tell working TLS from broken.)
 *
 * `x-forwarded-proto: https` is set because that is what a real reverse proxy
 * sends and what the app must see to treat the request as secure.
 *
 * ★★ IT ALSO HAS TO BEHAVE LIKE A REAL PROXY ON X-FORWARDED-FOR.
 *
 * This process stands exactly where the production edge stands, so anything it
 * gets wrong about client identity is wrong in QA in the same shape it would be
 * wrong in production. It previously forwarded `...req.headers` untouched, which
 * was wrong twice over:
 *
 *   1. It NEVER APPENDED the address it actually saw. `getClientIp`
 *      (apps/blog/lib/lite/http/ip.ts) reads the X-Forwarded-For entry
 *      `LITE_TRUSTED_PROXY_COUNT` hops from the RIGHT — the value our own
 *      infrastructure added — and with nothing appended there was nothing to
 *      read. Every client behind this front collapsed into the single
 *      `unattributed` bucket, so ONE caller could exhaust a per-IP budget for
 *      everybody, and no per-IP limit was really per-IP at all.
 *
 *   2. It PASSED A CLIENT-SUPPLIED X-Forwarded-For STRAIGHT THROUGH. A caller
 *      could send its own chain and have it arrive looking like ours, minting a
 *      fresh rate-limit bucket per request — the exact forgery proven exploitable
 *      on 2026-07-28 and fixed inside ip.ts, reintroduced here at the edge.
 *      Same for `x-real-ip`, which ip.ts trusts precisely because "our own edge
 *      sets it" — so it must be SET here, never relayed.
 *
 * The fix is ordinary correct proxy behaviour: APPEND the real socket peer to
 * whatever chain arrived, and overwrite `x-real-ip` with that same peer. Reading
 * from the right then lands on our entry no matter what a client prefixes, so a
 * forged chain is inert rather than authoritative. We do not normalise the
 * address here (IPv4-mapped IPv6, /64 bucketing) — `ipBucket` in ip.ts already
 * owns that, and duplicating it is how the two drift apart.
 *
 * ONE HOP, SO `LITE_TRUSTED_PROXY_COUNT=1` (the default) IS CORRECT BEHIND THIS
 * FRONT. If you put anything else in front of it, that number must grow to match
 * the real number of hops or the boundary moves to the wrong entry.
 */
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = process.env.LUMEN_TLS_DIR || path.join(ROOT, '.tls');
const UPSTREAM_PORT = Number(process.env.LUMEN_UPSTREAM_PORT || 3000);
const LISTEN_PORT = Number(process.env.LUMEN_TLS_PORT || 3443);

let opts;
try {
  opts = {
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem'))
  };
} catch {
  console.error(
    `No certificate in ${CERT_DIR}. Generate one:\n` +
      `  mkdir -p ${CERT_DIR} && openssl req -x509 -newkey rsa:2048 -nodes \\\n` +
      `    -keyout ${CERT_DIR}/key.pem -out ${CERT_DIR}/cert.pem -days 30 \\\n` +
      `    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`
  );
  process.exit(1);
}

/**
 * Build the upstream headers, fixing client identity at the trust boundary.
 *
 * `peer` is the address of the socket this request actually arrived on — the one
 * thing here a client cannot lie about. Appending it makes the rightmost entry
 * ours; overwriting `x-real-ip` with it stops a relayed forgery.
 *
 * If the peer is somehow unknown (a torn-down socket), we DROP both headers
 * rather than forward the inbound ones. That costs attribution — the request
 * lands in ip.ts's shared `unattributed` bucket — which is the safe failure. The
 * unsafe one would be relaying a chain we cannot vouch for, because then the
 * request gets a bucket of the caller's own choosing.
 */
function forwardHeaders(req) {
  const headers = { ...req.headers, 'x-forwarded-proto': 'https', host: `localhost:${LISTEN_PORT}` };
  const peer = req.socket?.remoteAddress;
  if (!peer) {
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    return headers;
  }
  const inbound = req.headers['x-forwarded-for'];
  const chain = Array.isArray(inbound) ? inbound.join(', ') : inbound;
  headers['x-forwarded-for'] = chain ? `${chain}, ${peer}` : peer;
  headers['x-real-ip'] = peer;
  return headers;
}

https
  .createServer(opts, (req, res) => {
    const proxy = http.request(
      {
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: forwardHeaders(req)
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res, { end: true });
      }
    );
    proxy.on('error', (e) => {
      res.writeHead(502);
      res.end('proxy error: ' + e.message);
    });
    req.pipe(proxy, { end: true });
  })
  .listen(LISTEN_PORT, () =>
    console.log(`TLS front on https://localhost:${LISTEN_PORT} -> http://127.0.0.1:${UPSTREAM_PORT}`)
  );
