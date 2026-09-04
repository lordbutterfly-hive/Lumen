/**
 * threespeak-embed validator + injector tests. Run:
 *   pnpm --filter @hive/blog exec ts-node --compilerOptions \
 *     '{"module":"commonjs","moduleResolution":"node"}' lib/post/threespeak-embed.test.ts
 *
 * Fires the attacker vectors against video.url (author-controlled json_metadata):
 * suffix host, userinfo, substring, wrong scheme, protocol-relative, bad v charset.
 */
import { threeSpeakEmbedUrl, bodyWithThreeSpeakPlayer } from './threespeak-embed';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

// --- threeSpeakEmbedUrl: valid ---
check('valid play.3speak.tv embed -> rebuilt 3speak.tv host', threeSpeakEmbedUrl('https://play.3speak.tv/embed?v=badadib/g9sgdk5h') === 'https://3speak.tv/embed?v=badadib/g9sgdk5h');
check('valid 3speak.tv watch -> embed', threeSpeakEmbedUrl('https://3speak.tv/watch?v=user/perm-link') === 'https://3speak.tv/embed?v=user/perm-link');
check('valid 3speak.online', threeSpeakEmbedUrl('https://3speak.online/embed?v=a1/b2') === 'https://3speak.tv/embed?v=a1/b2');

// --- threeSpeakEmbedUrl: attacker vectors (all must be null) ---
check('BLOCK suffix host 3speak.tv.evil.com', threeSpeakEmbedUrl('https://3speak.tv.evil.com/embed?v=a/b') === null);
check('BLOCK userinfo host 3speak.tv@evil.com', threeSpeakEmbedUrl('https://3speak.tv@evil.com/embed?v=a/b') === null);
check('BLOCK substring inside another url', threeSpeakEmbedUrl('https://evil.com/?x=3speak.tv/watch?v=a/b') === null);
check('BLOCK javascript: scheme', threeSpeakEmbedUrl('javascript:alert(1)//3speak.tv/watch?v=a/b') === null);
check('BLOCK protocol-relative', threeSpeakEmbedUrl('//3speak.tv/embed?v=a/b') === null);
check('BLOCK http (not https)', threeSpeakEmbedUrl('http://3speak.tv/embed?v=a/b') === null);
check('BLOCK bad v charset (quote/tag)', threeSpeakEmbedUrl('https://3speak.tv/embed?v=a"><script>/b') === null);
check('BLOCK v with no slash', threeSpeakEmbedUrl('https://3speak.tv/embed?v=nopermlink') === null);
check('BLOCK missing v', threeSpeakEmbedUrl('https://3speak.tv/embed') === null);
check('BLOCK empty / non-string', threeSpeakEmbedUrl('') === null && threeSpeakEmbedUrl(undefined) === null && threeSpeakEmbedUrl(42) === null);
check('BLOCK unrelated host', threeSpeakEmbedUrl('https://youtube.com/embed?v=a/b') === null);

// --- bodyWithThreeSpeakPlayer ---
const meta3 = { video: { platform: '3speak', url: 'https://play.3speak.tv/embed?v=badadib/g9sgdk5h' } };
check('injects the player when metadata is 3speak and body lacks it', bodyWithThreeSpeakPlayer('just text', meta3).startsWith('https://3speak.tv/embed?v=badadib/g9sgdk5h\n\n'));
check('does NOT double-render when body already has a 3speak url', bodyWithThreeSpeakPlayer('watch https://play.3speak.tv/embed?v=badadib/g9sgdk5h here', meta3) === 'watch https://play.3speak.tv/embed?v=badadib/g9sgdk5h here');
check('no inject for a non-3speak platform', bodyWithThreeSpeakPlayer('text', { video: { platform: 'youtube', url: 'https://play.3speak.tv/embed?v=a/b' } }) === 'text');
check('no inject when video.url is an attacker host', bodyWithThreeSpeakPlayer('text', { video: { platform: '3speak', url: 'https://3speak.tv.evil.com/embed?v=a/b' } }) === 'text');
check('no inject when no video metadata', bodyWithThreeSpeakPlayer('text', { tags: ['x'] }) === 'text' && bodyWithThreeSpeakPlayer('text', null) === 'text');

// eslint-disable-next-line no-console
console.log(`\n==== ${pass} pass / ${fail} fail ====`);
process.exit(fail ? 1 : 0);
