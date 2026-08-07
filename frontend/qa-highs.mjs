import { openApp, BASE } from '/home/clauderfly/hive-blog-rebuild/qa-harness.mjs';
const ok = (p,n,e)=>console.log(`  ${p?'PASS':'FAIL'}  ${n}\n        ${e}`);

// H2 — search on an apostrophe
{
  const { browser, page } = await openApp({});
  for (const q of ["don't", "O'Brien"]) {
    await page.goto(`${BASE}/search?q=${encodeURIComponent(q)}&s=relevance`, { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
    await page.waitForTimeout(6000);
    const b = (await page.locator('body').innerText()).replace(/\s+/g,' ');
    ok(!/No Data Available|problem fetching/i.test(b) && b.length > 400, `H2 search "${q}" works`, `${b.length} chars — ${b.slice(30,110)}`);
  }
  // zero-result wording
  await page.goto(`${BASE}/search?q=zzqxjjbbnnmmvv999&s=relevance`, { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(6000);
  const b = (await page.locator('body').innerText()).replace(/\s+/g,' ');
  ok(/No results for/i.test(b), 'H-search zero results says "no results"', b.slice(0, 130));
  await browser.close();
}
// H3 — lite post page clean for an anonymous visitor
{
  const { browser, page } = await openApp({});
  const bad = [];
  page.on('response', async (r) => { if (r.request().url()==='https://api.hive.blog/') { const t=await r.text().catch(()=>''); if (t.includes('does not exist')) bad.push(1);} });
  await page.goto(BASE + '/blog/@bravouyuce/lite-01kzcdvp09gnb0cybzwawfbpp1', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(13000);
  const b = (await page.locator('body').innerText()).replace(/\s+/g,' ');
  const toasts = (await page.locator('[data-radix-toast-viewport] *').allInnerTexts().catch(()=>[])).join(' ');
  ok(bad.length===0, 'H3 no chain assertions on a lite post page', `${bad.length}`);
  ok(!/Error/.test(toasts), 'H3 no raw error toast', JSON.stringify(toasts.slice(0,80)) || 'none');
  ok(!/taking longer than usual/i.test(b), 'H3 banner no longer claims high traffic', (b.match(/.{0,80}(Lumen\.|indexing|publish).{0,40}/i)||['n/a'])[0]);
  await browser.close();
}
// H4/H6 — publish confirmation + readable errors
{
  const { browser, page } = await openApp({ loggedIn: true, label: 'hh' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip for now'); if (await skip.count()) { await skip.click(); await page.waitForTimeout(8000); }
  await page.goto(BASE + '/submit.html', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(3000);
  const title = page.locator('input[name="title"], input#title').first();
  const submit = page.getByRole('button', { name: /^Submit$/ }).first();
  if (await title.count()) {
    await title.fill('   ');
    const body = page.locator('textarea').first();
    if (await body.count()) await body.fill('some body text for the whitespace title check');
    await page.waitForTimeout(1500);
    ok(await submit.isDisabled().catch(()=>null) === true, 'H5/H6 whitespace-only title keeps Submit disabled', `disabled=${await submit.isDisabled().catch(()=>'?')}`);
  } else ok(false, 'H5 editor fields found', 'title input not found');
  await browser.close();
}
