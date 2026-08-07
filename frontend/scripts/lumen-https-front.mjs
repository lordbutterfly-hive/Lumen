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

https
  .createServer(opts, (req, res) => {
    const proxy = http.request(
      {
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'x-forwarded-proto': 'https',
          host: `localhost:${LISTEN_PORT}`
        }
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
