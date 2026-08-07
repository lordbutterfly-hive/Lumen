import { openApp, BASE } from '/home/clauderfly/hive-blog-rebuild/qa-harness.mjs';
const ok=(p,n,e)=>console.log(`  ${p?'PASS':'FAIL'}  ${n}\n        ${e}`);
{
  const { browser, page } = await openApp({});
  // navigate FIRST so fetch has a real origin (the harness lesson, again)
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  const av = await page.evaluate(async () => {
    const r = await fetch('/api/avatar?username=akatsuki28121997&size=small');
    return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
  });
  ok(av.status === 200 && /image|svg/.test(av.type||''), 'M2 dead image host serves a real avatar', `HTTP ${av.status} ${av.type} ${av.bytes}B`);

  // M1 — read the BYLINE element, not the whole page
  await page.goto(BASE + '/hive-174301/@silviabeneforti/a-new-flying-bird-oil-on-cardboard', { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(7000);
  const byline = (await page.locator('[data-testid="comment-community-title"], [data-testid="comment-category-title"]').allInnerTexts().catch(()=>[])).join(' | ');
  ok(byline.length > 0 && !/hive-\d/.test(byline), 'M1 byline shows a name, not a community id', JSON.stringify(byline) || '(byline element not found)');

  // M6 — wait for the list region to settle
  await page.goto(BASE + '/trending/thistagdefinitelydoesnotexist12345', { waitUntil: 'networkidle', timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(15000);
  const b = (await page.locator('body').innerText()).replace(/\s+/g,' ');
  ok(/Nobody has posted/i.test(b), 'M6 empty tag has an empty state', (b.match(/Unmoderated tag(.{0,90})/)||[b.slice(-120)])[0]);
  ok(!/problem fetching|node is running/i.test(b), 'M6 empty tag does not blame the node', 'no fetch-error panel');
  await browser.close();
}
{
  const { browser, page } = await openApp({ loggedIn: true, label: 'm2' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip for now'); if (await skip.count()) { await skip.click(); await page.waitForTimeout(8000); }
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForTimeout(2000);
  await page.getByText("What's on your mind?").first().click();
  const ta = page.locator('textarea').first(); await ta.waitFor({state:'visible',timeout:10000});
  await ta.fill('Composer confirmation check ' + Date.now().toString(36));
  await page.getByRole('button', { name: /^Post$/ }).first().click();
  await page.waitForTimeout(3500);
  // Radix renders the viewport as a plain <ol>; there is no
  // `data-radix-toast-viewport` attribute, and selecting one reported a working
  // toast as missing twice.
  const toast = (await page.locator('ol li').allInnerTexts().catch(()=>[])).join(' ').replace(/\s+/g,' ');
  ok(/Post published/i.test(toast), 'H4 composer confirms the post', JSON.stringify(toast.slice(0,110)));
  await browser.close();
}
