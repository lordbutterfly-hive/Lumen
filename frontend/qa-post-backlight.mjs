import { openApp, BASE } from './qa-harness.mjs';
import { PNG } from 'pngjs';
const { browser, page } = await openApp({ loggedIn: true });
await page.setViewportSize({ width: 1600, height: 900 });
await page.goto(BASE + '/moviereviews/@hanshotfirst/a-geeky-guy-s-guide-to-shoresy', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const art = [...document.querySelectorAll('div,article')].find((e) => /rounded-xl/.test(e.className) && /shadow-\[/.test(e.className))
    || document.querySelector('article');
  const cs = art ? getComputedStyle(art) : null;
  return {
    articleShadow: cs ? cs.boxShadow : 'not found',
    bodyBg: getComputedStyle(document.body).backgroundImage.slice(0, 110),
    attachment: getComputedStyle(document.body).backgroundAttachment
  };
});
console.log('  article shadow :', info.articleShadow);
console.log('  body gradient  :', info.bodyBg);
console.log('  attachment     :', info.attachment);
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 1600, height: 400 } });
const png = PNG.sync.read(buf);
const at = (x, y) => { const i = (png.width * y + x) << 2; return `${png.data[i]},${png.data[i+1]},${png.data[i+2]}`; };
console.log('  ground @x=6    :', at(6, 300), '(edge — expect 247,242,235)');
console.log('  ground @x=180  :', at(180, 300));
console.log('  ground @x=1594 :', at(1594, 300), '(far edge)');
await browser.close();
