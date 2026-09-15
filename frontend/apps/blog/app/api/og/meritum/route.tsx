import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CREATOR_TOKEN_LAUREL_PATH } from '@/blog/features/creator-tokens/ui/creator-token-laurel';
import { displayHandle } from '@/blog/features/creator-tokens/live/adapt';
import { usdPrice } from '@/blog/features/creator-tokens/market/format';
import { HIVE_USERNAME, isRoutableCreatorHandle, normalizeCreatorHandle } from '@/blog/lib/meritum/creator-handle';
import { truncateOnWord } from '@/blog/lib/meritum/profile-fields';
import { readCreatorMarketSummary } from '@/blog/lib/meritum/server-market';
import { readCreatorProfile } from '@/blog/lib/meritum/server-profile';

/**
 * ★★★ THE MERITUM SHARE CARD — `/api/og/meritum?u=<handle>` (handoff §4,
 * 2026-09-15). 1200 x 630 on the LP8 frame `/api/og` already draws for posts
 * (paper, 84/88 margins, a 4px rule on the floor), with the payload this card
 * sells: the laurel imprint, the creator's face, their handle, their Hive
 * `about`, and one CTA with the live price. Same source, same numbers as the
 * page — the profile and the price come from the SAME two server reads
 * `/m/<handle>` uses, so the card and the page cannot disagree.
 *
 * ★★ SECURITY, because this is a public image at our domain that anyone can
 * link to from anywhere:
 *  - NOTHING RENDERED COMES FROM THE QUERY STRING. `u` names the creator and
 *    is validated to a Hive name or a DID; `v` is a cache key the page bumps
 *    when the price moves and is otherwise ignored. A card with a made-up
 *    price or a made-up sentence, hosted here, would be a phishing lure with
 *    our name on it — so the price is read from the chain and the about from
 *    the account, on every render, and no parameter can override either.
 *  - THE SERVER FETCHES NO USER-SUPPLIED URL. The face is Hive's own image
 *    proxy addressed by the validated account name (`images.hive.blog/u/<name>/
 *    avatar/large`), never the raw `profile_image` value: a URL an attacker
 *    chose, fetched by our server, is an SSRF hole. A DID creator, or a fetch
 *    that fails or is slow, gets the generated initial disc — never a broken
 *    image, never a grey circle (§2).
 *  - `about` arrives sanitised (controls and bidi overrides stripped, capped)
 *    and is truncated to two lines here on a word.
 *
 * ★ CACHED, KEYED ON THE PRICE. `public, s-maxage=600` at the edge; the page
 * puts the price (in cents) in the URL, so a moved price is a new URL and a
 * stale card cannot outlive it in a crawler cache. Upstream reads are the
 * cached server reads (30 s market, 60 s profile), so a share fanning out to
 * a dozen unfurlers at once costs the node one read.
 *
 * ★ FONTS ARE VENDORED STATIC CUTS (see `/api/og`'s header for why: Satori
 * cannot read woff2 or variable fonts). `Lora-Regular.ttf` is instantiated
 * from the same woff2 the site serves; both files must keep no `fvar` table.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAPER = '#fcfaf7';
const INK = '#161511';
const INK_SOFT = '#3D362F';
const IMPRINT = '#6b7280';
const BRAND = '#C0392B';
const PAPER_0 = '#FFFEFC';

const AVATAR_TIMEOUT_MS = 2_500;
const AVATAR_MAX_BYTES = 1_500_000;

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(process.cwd(), 'public', 'fonts', file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Hive's image proxy, by NAME: the only remote fetch this route makes, to one fixed host. */
async function hiveAvatarDataUri(name: string): Promise<string | null> {
  if (!HIVE_USERNAME.test(name)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
  try {
    const res = await fetch(`https://images.hive.blog/u/${encodeURIComponent(name)}/avatar/large`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpeg|jpg|webp|gif)/i.test(type)) return null;
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > AVATAR_MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return null;
    return `data:${type.split(';')[0]};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The size ladder: a long handle steps down so the face, the gap and the name stay inside 1024px. */
function handleSize(shown: string): number {
  if (shown.length <= 13) return 96;
  if (shown.length <= 17) return 76;
  return 60;
}

function Laurel({ size, color, opacity }: { size: number; color: string; opacity?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={{ opacity: opacity ?? 1 }}>
      <path d={CREATOR_TOKEN_LAUREL_PATH} />
    </svg>
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const raw = (req.nextUrl.searchParams.get('u') ?? '').trim();
  if (!raw || raw.length > 200) return new Response('not found', { status: 404 });
  const handle = normalizeCreatorHandle(raw);
  if (!isRoutableCreatorHandle(handle)) return new Response('not found', { status: 404 });

  const [summary, profile, bold, regular] = await Promise.all([
    readCreatorMarketSummary(handle),
    readCreatorProfile(handle),
    font('Lora-Bold.ttf'),
    font('Lora-Regular.ttf')
  ]);
  // No market, no card: a 404 here is what stops a crawler caching a picture
  // that says "Buy their Meritum" about someone who has none. A failed read
  // (null) still draws — with no price line rather than a wrong one.
  if (summary && !summary.registered) return new Response('not found', { status: 404 });

  const shown = displayHandle(handle);
  const about = profile.about ? truncateOnWord(profile.about, 110) : null;
  const face = await hiveAvatarDataUri(handle);
  const initial = (profile.displayName || shown).trim().charAt(0).toUpperCase() || '@';
  const price = summary ? usdPrice(summary.priceUsd) : null;
  const nameSize = handleSize(shown);

  const image = new ImageResponse(
    (
      <div
        style={{
          width: '1200px',
          height: '630px',
          display: 'flex',
          backgroundColor: PAPER,
          backgroundImage: `radial-gradient(circle at 90% 6%, rgba(192, 57, 43, 0.08), transparent 45%)`,
          position: 'relative',
          overflow: 'hidden',
          fontFamily: 'Lora'
        }}
      >
        {/* The big laurel: fully inside the card, 38px clear of the right edge, a wash not a subject. */}
        <div style={{ position: 'absolute', right: '38px', top: '26px', display: 'flex' }}>
          <Laurel size={360} color={BRAND} opacity={0.17} />
        </div>

        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '1200px',
            height: '630px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '84px 88px'
          }}
        >
          {/* Imprint: the mark, pulled left so its optical edge lands on the margin, then MERITUM tracked wide. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '-3px' }}>
            <Laurel size={30} color={BRAND} />
            <div style={{ display: 'flex', fontSize: '23px', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: IMPRINT, lineHeight: 1 }}>
              Meritum
            </div>
          </div>

          {/* Payload: face and name flush at the top, the about under the name. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '28px' }}>
            {face ? (
              <img
                src={face}
                width={132}
                height={132}
                style={{ width: '132px', height: '132px', borderRadius: '999px', objectFit: 'cover', flexShrink: 0, border: `4px solid ${INK}` }}
              />
            ) : (
              <div
                style={{
                  width: '132px',
                  height: '132px',
                  borderRadius: '999px',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: '#FAEEEB',
                  border: `4px solid ${BRAND}`,
                  color: BRAND,
                  fontSize: '58px',
                  fontWeight: 700
                }}
              >
                {initial}
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: '860px' }}>
              <div style={{ display: 'flex', fontSize: `${nameSize}px`, fontWeight: 700, lineHeight: 1.04, letterSpacing: '-0.04em', color: INK }}>
                @{shown}
              </div>
              {about ? (
                <div style={{ display: 'flex', marginTop: '12px', fontSize: '22px', fontWeight: 400, lineHeight: 1.36, color: INK_SOFT, maxHeight: '60px', overflow: 'hidden' }}>
                  {about}
                </div>
              ) : null}
            </div>
          </div>

          {/* The CTA row, then the rule on the floor. */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '22px', marginBottom: '30px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: '62px',
                  padding: '0 32px',
                  borderRadius: '999px',
                  backgroundColor: BRAND,
                  color: PAPER_0,
                  fontSize: '24px',
                  fontWeight: 700
                }}
              >
                Buy their Meritum
              </div>
              {price ? (
                // Baseline-aligned as a pair, so "per token" sits on the price's
                // baseline rather than floating at the row's centre line.
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                  <div style={{ display: 'flex', fontSize: '34px', fontWeight: 700, letterSpacing: '-0.02em', color: INK }}>{price}</div>
                  <div style={{ display: 'flex', fontSize: '20px', fontWeight: 400, color: '#6E645A' }}>per token</div>
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', width: '100%', height: '4px', backgroundColor: INK }} />
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Lora', data: bold, weight: 700, style: 'normal' },
        { name: 'Lora', data: regular, weight: 400, style: 'normal' }
      ]
    }
  );
  image.headers.set('cache-control', 'public, s-maxage=600, stale-while-revalidate=86400');
  return image;
}
