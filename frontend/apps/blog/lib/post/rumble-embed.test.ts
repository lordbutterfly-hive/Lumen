/**
 * UNIT TESTS for lib/post/rumble-embed.ts (2026-10-06). The oEmbed body below is the
 * real answer Rumble gave for `rumble.com/v6ur90f-i-am-cat-muti-player-quest-3-headset.html`
 * (trimmed to the fields read). Run by `pnpm --filter @hive/blog test:unit`; own harness.
 */
import { parseRumblePage, rumbleOembedUrl, embedIdFromOembed, isRumbleEmbedId } from './rumble-embed';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const real = {
  type: 'video',
  provider_name: 'Rumble.com',
  html: '<iframe src="https://rumble.com/embed/v6skcrl/" width="1024" height="1024" frameborder="0" title="i am cat muti player quest 3 headset" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe>'
};

const page = parseRumblePage('v6ur90f-i-am-cat-muti-player-quest-3-headset');
ok('parses a page path into its id and path', !!page && page.pageId === 'v6ur90f' && page.page === 'v6ur90f-i-am-cat-muti-player-quest-3-headset');
ok('the cache key ignores the title', parseRumblePage('v6ur90f-x')?.pageId === 'v6ur90f');
ok(
  'builds the oEmbed URL for exactly that page on rumble.com',
  !!page && rumbleOembedUrl(page) === 'https://rumble.com/api/Media/oembed.json?url=https%3A%2F%2Frumble.com%2Fv6ur90f-i-am-cat-muti-player-quest-3-headset.html'
);
for (const bad of [null, '', 'v6ur90f', 'x6ur90f-title', 'v6ur90f-../../evil', 'v6ur90f-a/b', 'v6ur90f-a?x=1', 'v6ur90f-a"b', 'v6ur90f-a b', `v6ur90f-${'a'.repeat(201)}`, 'https://evil.com/v6ur90f-a']) {
  ok(`rejects page ${JSON.stringify(bad)}`, parseRumblePage(bad) === null);
}
ok('reads the player id from the real oEmbed answer', embedIdFromOembed(real) === 'v6skcrl');
ok('reads it from a JSON-escaped src too', embedIdFromOembed({ html: '<iframe src=\\"https://rumble.com/embed/v6skcrl/\\"></iframe>' }) === 'v6skcrl');
for (const [label, body] of [
  ['no html', { type: 'video' }],
  ['html not a string', { html: 42 }],
  ['a different host', { html: '<iframe src="https://evil.com/embed/v6skcrl/"></iframe>' }],
  ['a look-alike host', { html: '<iframe src="https://rumble.com.evil.com/embed/v6skcrl/"></iframe>' }],
  ['a hostile id', { html: '<iframe src="https://rumble.com/embed/v6"onload=x/"></iframe>' }],
  ['not an object', 'html'],
  ['null', null]
] as Array<[string, unknown]>) {
  ok(`no player id when ${label}`, embedIdFromOembed(body) === null);
}
ok('accepts a real player id', isRumbleEmbedId('v6skcrl'));
for (const bad of ['', 'v6"x', '../x', 'a', 'v6skcrl/', 42, null]) ok(`rejects player id ${JSON.stringify(bad)}`, !isRumbleEmbedId(bad));

if (failures === 0) {
  console.log(`\nrumble-embed: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nrumble-embed: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
