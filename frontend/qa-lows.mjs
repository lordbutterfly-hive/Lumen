import { openApp, BASE } from '/home/clauderfly/hive-blog-rebuild/qa-harness.mjs';
const ok=(p,n,e)=>console.log(`  ${p?'PASS':'FAIL'}  ${n}\n        ${e}`);
{
  const { browser, page, failedRequests } = await openApp({ loggedIn: true, label: 'low' });
  const streak = [], hs = [];
  page.on('request', r => { if (/\/api\/streak\//.test(r.url())) streak.push(r.url()); if (/hivesense/.test(r.url())) hs.push(r.url()); });
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip for now'); if (await skip.count()) { await skip.click(); await page.waitForTimeout(8000); }
  streak.length = 0;
  const u = (await page.evaluate(() => fetch('/api/users/me').then(r=>r.json()))).username;
  for (const path of ['/', `/@${u}`]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(5000);
  }
  ok(streak.length === 0, 'L1 no /api/streak calls for a lite account', `${streak.length} calls`);
  await browser.close();
}
{
  const { browser, page } = await openApp({});
  const hs = [];
  page.on('request', r => { if (/hivesense/.test(r.url())) hs.push(r.url().slice(0,70)); });
  await page.goto(BASE + '/hive-174301/@silviabeneforti/a-new-flying-bird-oil-on-cardboard', { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(9000);
  ok(!hs.some(u => /similar/.test(u)), 'L2 no similar-posts call when Hivesense is absent', hs.join(' | ') || 'none');

  // L3 legacy followers page numbers
  await page.goto(BASE + '/@bhattg/followers', { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(7000);
  const b = (await page.locator('body').innerText()).replace(/\s+/g,' ');
  const raw = (b.match(/\b\d{4,}\b/g)||[]).filter(n => !/^(19|20)\d\d$/.test(n));
  ok(raw.length === 0, 'L3 legacy profile stats are comma-formatted', raw.length ? `unformatted: ${raw.slice(0,5).join(', ')}` : (b.match(/[\d,]+ Followers/)||['n/a'])[0]);

  // L4 dead market link
  await page.goto(BASE + '/wallet', { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(6000);
  const dead = await page.locator('a[href="#"]').count();
  ok(dead === 0, 'L4 no dead "#" links on the wallet', `${dead} such links`);
  await browser.close();
}
