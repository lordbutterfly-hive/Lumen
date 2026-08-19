import { chromium } from 'playwright';
const B='http://127.0.0.1:3000';
const b=await chromium.launch({executablePath:'/home/clauderfly/opt/chrome-root/opt/google/chrome/chrome',headless:true,args:['--no-sandbox']});
const ctx=await b.newContext({viewport:{width:1440,height:900}});
const fail=[];
const ok=(c,m)=>{ console.log((c?'  PASS':'  FAIL')+'  '+m); if(!c) fail.push(m); };

// ── C4 paper + C5 ladder + C7 brand: tokens resolve, in the right colour space ──
{
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const t=await p.evaluate(()=>{
    const cs=getComputedStyle(document.documentElement);
    const probe=(css)=>{const d=document.createElement('div');d.style.color=css;document.body.appendChild(d);const v=getComputedStyle(d).color;d.remove();return v;};
    return {bg:getComputedStyle(document.body).backgroundColor,
      lift1:cs.getPropertyValue('--lift-1').trim().slice(0,20),
      lift3:cs.getPropertyValue('--lift-3').trim().slice(0,20),
      headerH:cs.getPropertyValue('--header-h').trim(),
      brand:probe('rgb(var(--brand))')};
  });
  console.log('\n== tokens ==', JSON.stringify(t));
  ok(t.bg==='rgb(252, 250, 248)', `C4 page background is paper (got ${t.bg})`);
  ok(!!t.lift1 && !!t.lift3, 'C5 --lift-1 and --lift-3 defined');
  ok(t.headerH==='81px', `C5/A4 --header-h resolves at desktop (got ${t.headerH})`);
  ok(t.brand==='rgb(192, 57, 43)', `C7 --brand renders as #c0392b through rgb() (got ${t.brand})`);
  await p.close();
}
// ── A4 phone: --header-h matches the real header ──
{
  const c2=await b.newContext({viewport:{width:390,height:800}}); const p=await c2.newPage();
  await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000);
  const r=await p.evaluate(()=>({real:Math.round(document.querySelector('header').getBoundingClientRect().height),
    tok:getComputedStyle(document.documentElement).getPropertyValue('--header-h').trim()}));
  console.log('\n== A4 phone ==', JSON.stringify(r));
  ok(r.tok===r.real+'px', `A4 --header-h (${r.tok}) matches measured header (${r.real}px)`);
  await c2.close();
}
// ── C2 radii: no arbitrary pixel radius survives in the shipped CSS ──
{
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const r=await p.evaluate(()=>{
    const seen=new Set();
    for(const el of document.querySelectorAll('body *')){
      const v=getComputedStyle(el).borderTopLeftRadius;
      if(v && v!=='0px') seen.add(v);
    }
    return [...seen].sort();
  });
  console.log('\n== C2 distinct radii in use ==', JSON.stringify(r));
  const px=r.filter(v=>/^\d+(\.\d+)?px$/.test(v)).map(v=>parseFloat(v)).filter(v=>v<100);
  const allowed=new Set([10,14,18]);
  const stray=px.filter(v=>!allowed.has(v));
  ok(stray.length===0, `C2 only 10/14/18 px radii remain (stray: ${stray.join(',')||'none'})`);
  await p.close();
}
// ── C10 + tabular numbers on the post card action row ──
{
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(7000);
  const r=await p.evaluate(()=>{
    const card=document.querySelector('article'); if(!card) return {err:'no card'};
    const bottom=card.getBoundingClientRect().bottom;
    // LEAF nodes only. The first version walked containers too, whose textContent is the
    // concatenation of their children ("29631$13") - it reported failures for elements
    // that hold no number of their own.
    const nums=[...card.querySelectorAll('*')]
      .filter(e=>e.children.length===0 && /\d/.test(e.textContent||'') && (e.textContent||'').trim()
                 && e.getBoundingClientRect().top>bottom-90);
    return {total:nums.length, normal:nums.filter(e=>getComputedStyle(e).fontVariantNumeric!=='tabular-nums').map(e=>e.textContent.trim().slice(0,8))};
  });
  console.log('\n== numbers ==', JSON.stringify(r));
  ok(r.normal && r.normal.length===0, `tabular-nums on every action-row number (non-tabular: ${(r.normal||[]).join(',')||'none'})`);
  await p.close();
}
// ── A7/A8 headings ──
{
  console.log('\n== A7/A8 headings ==');
  for(const u of ['/communities','/security','/tos.html','/upgrade','/ranks','/topics/hive','/search']){
    const p=await ctx.newPage();
    try{ await p.goto(B+u,{waitUntil:'domcontentloaded',timeout:25000}); }catch{ console.log('  NAV-FAIL',u); await p.close(); continue; }
    await p.waitForTimeout(3500);
    const r=await p.evaluate(()=>{
      const hs=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h=>+h.tagName[1]);
      const jumps=[]; let prev=0; for(const l of hs){ if(prev&&l>prev+1) jumps.push(prev+'->'+l); prev=l; }
      return {h1:document.querySelectorAll('h1').length, jumps};
    });
    ok(r.h1>=1 && r.jumps.length===0, `${u} h1=${r.h1} jumps=${r.jumps.join(' ')||'none'}`);
    await p.close();
  }
}
// ── C3 CLS on post bodies ──
{
  console.log('\n== C3 post-body CLS ==');
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const hrefs=await p.evaluate(()=>[...new Set([...document.querySelectorAll('a[href*="/@"]')]
    .map(a=>a.getAttribute('href')||'').filter(h=>/\/@[^/]+\/[^/]+$/.test(h)))].slice(0,6));
  await p.close();
  let tested=0;
  for(const h of hrefs){
    const p2=await ctx.newPage();
    await p2.addInitScript(()=>{window.__cls=0;new PerformanceObserver(l=>{for(const e of l.getEntries()) if(!e.hadRecentInput) window.__cls+=e.value;}).observe({type:'layout-shift',buffered:true});});
    try{ await p2.goto(B+h,{waitUntil:'domcontentloaded',timeout:30000}); }catch{ await p2.close(); continue; }
    await p2.waitForTimeout(8000);
    const r=await p2.evaluate(()=>{
      const body=document.querySelector('.prose,.entry-body,article,main');
      const imgs=body?[...body.querySelectorAll('img')]:[];
      return {cls:+window.__cls.toFixed(4), imgs:imgs.length,
        reserved:imgs.filter(i=>getComputedStyle(i).aspectRatio!=='auto').length};
    });
    if(r.imgs>0){ tested++; ok(r.cls<0.1, `${h.slice(0,42)} CLS=${r.cls} (${r.reserved}/${r.imgs} images reserved)`); }
    await p2.close();
    if(tested>=2) break;
  }
  if(!tested){ console.log('  INCONCLUSIVE: no post with body images sampled'); fail.push('C3 not measurable'); }
}
// ── ICONS: one resting colour, one comment glyph ──────────────────────────────
{
  console.log('\n== icons ==');
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(7000);
  const r=await p.evaluate(()=>{
    const card=document.querySelector('article');
    const bottom=card.getBoundingClientRect().bottom;
    // the action-row icons: svgs in the last ~90px of the card
    const rowIcons=[...card.querySelectorAll('svg')].filter(s=>s.getBoundingClientRect().top>bottom-90);
    const colours=rowIcons.map(s=>getComputedStyle(s).color);
    // every distinct icon colour on the page, for the spread count
    const all=new Set();
    for(const s of document.querySelectorAll('svg')){
      const b=s.getBoundingClientRect();
      if(b.width>0&&b.height>0) all.add(getComputedStyle(s).color);
    }
    // comment glyph: compare the path data used across cards with different counts
    const glyphs={};
    for(const a of document.querySelectorAll('[data-testid="post-children"]')){
      const svg=a.querySelector('svg'); const n=(a.textContent||'').trim();
      if(!svg) continue;
      const d=[...svg.querySelectorAll('path,circle,rect,line,polyline')].map(e=>e.getAttribute('d')||e.tagName).join('|');
      (glyphs[d] ||= []).push(n);
    }
    return {rowColours:colours, distinctOnPage:[...all].sort(), glyphVariants:Object.values(glyphs).map(v=>v.slice(0,6))};
  });
  console.log('  action-row icon colours :', JSON.stringify(r.rowColours));
  console.log('  distinct icon colours   :', r.distinctOnPage.length, JSON.stringify(r.distinctOnPage));
  console.log('  comment glyph variants  :', r.glyphVariants.length, JSON.stringify(r.glyphVariants));
  const uniqueRow=[...new Set(r.rowColours)];
  ok(uniqueRow.length===1 && uniqueRow[0]==='rgb(110, 100, 90)',
     `action row is ONE colour = ink-action (got ${JSON.stringify(uniqueRow)})`);
  ok(r.glyphVariants.length<=1, `comment icon is one glyph at every count (variants: ${r.glyphVariants.length})`);
  ok(r.distinctOnPage.length<=6, `icon colour spread reduced (distinct: ${r.distinctOnPage.length}, was 8)`);
  await p.close();
}
// ── NAV: the brand-tint seat, its rule, and a neutral hover ───────────────────
{
  console.log('\n== nav (design nav-2a) ==');
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const before=await p.evaluate(()=>{
    const nav=document.querySelector('[data-testid="left-rail-nav"]');
    if(!nav) return {err:'no left rail'};
    const rows=[...nav.querySelectorAll('span[data-active], a > span')];
    const active=[...nav.querySelectorAll('[data-active="true"]')];
    const a=active[0];
    const rule=a?getComputedStyle(a,'::before'):null;
    return {
      rows:rows.length,
      activeCount:active.length,
      activeBg:a?getComputedStyle(a).backgroundColor:null,
      activeColor:a?getComputedStyle(a).color:null,
      activeWeight:a?getComputedStyle(a).fontWeight:null,
      ruleWidth:rule?rule.width:null,
      ruleBg:rule?rule.backgroundColor:null,
      idleBg:(()=>{const idle=rows.find(r=>r.getAttribute('data-active')!=='true');return idle?getComputedStyle(idle).backgroundColor:null;})()
    };
  });
  console.log('  ', JSON.stringify(before));
  ok(before.activeCount===1, `exactly one active row (got ${before.activeCount})`);
  ok(before.activeBg==='rgb(250, 238, 235)', `active seat is the brand tint (got ${before.activeBg})`);
  ok(before.activeColor==='rgb(150, 39, 27)', `active label is ink-brand-4, the AA-passing red (got ${before.activeColor})`);
  ok(before.activeWeight==='600', `active label is weight 600 (got ${before.activeWeight})`);
  ok(before.ruleWidth==='2px', `2px rule present on the active row (got ${before.ruleWidth})`);
  ok(before.ruleBg==='rgb(192, 57, 43)', `rule is the full brand red (got ${before.ruleBg})`);

  // hover must be the NEUTRAL wash, not the old warm brand tint
  const hovered=await p.evaluate(async ()=>{
    const nav=document.querySelector('[data-testid="left-rail-nav"]');
    const idle=[...nav.querySelectorAll('a > span')].find(r=>r.getAttribute('data-active')!=='true');
    if(!idle) return null;
    idle.parentElement.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    return {tag:idle.tagName};
  });
  if(hovered){
    const idleSel='[data-testid="left-rail-nav"] a > span:not([data-active])';
    await p.hover(idleSel).catch(()=>{});
    await p.waitForTimeout(400);
    const hv=await p.evaluate((sel)=>{const e=document.querySelector(sel);return e?getComputedStyle(e).backgroundColor:null;}, idleSel);
    console.log('   hovered row bg:', hv);
    ok(hv==='rgb(242, 239, 234)', `hover is the neutral paper wash, not the old warm brand tint (got ${hv})`);
  }
  await p.close();
}
// ── no live link may depend on a retired-sort redirect ───────────────────────
{
  console.log('\n== retired-sort dependencies ==');
  const p=await ctx.newPage(); await p.goto(B+'/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(6000);
  const hrefs=await p.evaluate(()=>[...document.querySelectorAll('a[href]')]
    .map(a=>a.getAttribute('href')||'')
    .filter(h=>/^\/(trending|hot|created|payout|muted)(\/|$)/.test(h)));
  await p.close();
  ok(hrefs.length===0, `home feed has no link to a retired sort (found: ${hrefs.slice(0,4).join(', ')||'none'})`);

  /**
   * The one that mattered: a hashtag inside a real post body must resolve in ONE hop.
   *
   * ★ IT SAMPLES SEVERAL POSTS, BECAUSE ONE IS NOT ENOUGH. The first version checked a
   * single hard-coded post, which happened to contain no hashtags at all, so the check
   * reported "inconclusive" - correct behaviour, useless result. Plenty of posts carry no
   * tags; a check that depends on the luck of the draw is a check that will be ignored.
   */
  let tagsChecked = 0;
  const feed = await ctx.newPage();
  await feed.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await feed.waitForTimeout(6000);
  const posts = await feed.evaluate(() =>
    [...new Set([...document.querySelectorAll('a[href*="/@"]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => /\/@[^/]+\/[^/]+$/.test(h)))].slice(0, 20)
  );
  await feed.close();

  for (const u of posts) {
    // Widened 8 -> 20 posts (2026-08-19). The fix itself is verified - three body
    // hashtags were measured resolving 200 in one hop - but on a feed whose first 8 posts
    // happened to carry no tags the check reported INCONCLUSIVE. Correct behaviour,
    // useless result; a check that depends on the luck of the feed is one people learn to
    // ignore. Sampling wider makes the honest-inconclusive path rare rather than routine.
    if (tagsChecked >= 3) break;
    const q = await ctx.newPage();
    try {
      await q.goto(B + u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      await q.close();
      continue;
    }
    await q.waitForTimeout(6000);
    const tags = await q.evaluate(() => {
      const body = document.querySelector('#articleBody');
      if (!body) return [];
      return [...body.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => /^\/(topics|trending)\//.test(h))
        .slice(0, 3);
    });
    await q.close();
    for (const t of tags) {
      const r = await ctx.request.get(B + t, { maxRedirects: 0 }).catch(() => null);
      const st = r ? r.status() : null;
      tagsChecked++;
      ok(st === 200, `post-body hashtag resolves in one hop: ${t} -> ${st}`);
    }
  }
  if (tagsChecked === 0) {
    console.log('   no post-body hashtag found across', posts.length, 'posts; check is inconclusive');
    fail.push('hashtag check inconclusive');
  }
}
// ── GOOGLE SIGN-IN NEVER DISABLES ITSELF ─────────────────────────────────────
/**
 * ★★★ THIS CHECKS OUR CONTRACT, NOT GOOGLE'S AVAILABILITY - and the first version got
 * that wrong, which is worth recording because it wasted the owner's time twice.
 *
 * v1 asserted "the Google button renders" and, when it did not, printed instructions to
 * add the origin in Google Cloud Console. Both halves were mistakes:
 *
 *  - It measured GOOGLE. A headless browser gets a 403 from /gsi/button that a real
 *    browser does not, so this check failed permanently in CI for a reason that does not
 *    exist for a user. A check that cannot pass in the environment it runs in is noise.
 *  - The remediation text was WRONG. The origin is fine in a real browser (verified in
 *    the owner's Chrome: no `origin is not allowed` from GSI_LOGGER). The actual defect
 *    was ours: GSI renders its overlay iframe at 0x0 when it beats layout, and our
 *    component treated that single geometry sample as proof Google was down, then set
 *    `aria-disabled` and `pointer-events: none` on the row - permanently killing the one
 *    sign-in path aimed at people without a crypto wallet.
 *
 * So the regression to guard is OURS and is provable anywhere: after the grace period and
 * every retry, the row must still be interactive. Whether Google's iframe has size is
 * reported as diagnostics, never asserted.
 */
{
  console.log('\n== google sign-in (fail-open contract) ==');
  const p = await ctx.newPage();
  let buttonStatus = null;
  p.on('response', (r) => {
    if (r.url().includes('/gsi/button')) buttonStatus = r.status();
  });
  await p.goto(B + '/login', { waitUntil: 'domcontentloaded' });
  // Past RENDER_GRACE_MS (6s) plus every RENDER_RETRY_MS (1.5s x3) so the component has
  // fully given up before we look. If it is going to disable itself, it has by now.
  await p.waitForTimeout(13000);
  const g = await p.evaluate(() => {
    const row = document.querySelector('[data-testid="google-signin-row"]');
    if (!row) return { missing: true };
    const fr = row.querySelector('iframe[src*="accounts.google.com"]');
    const r = fr ? fr.getBoundingClientRect() : null;
    // The overlay that carries Google's real button.
    const overlay = row.querySelector('.absolute.inset-0');
    return {
      missing: false,
      ariaDisabled: row.getAttribute('aria-disabled'),
      overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
      dimmed: /opacity-60/.test(row.className || ''),
      iframe: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : 'NONE'
    };
  });
  await p.close();
  console.log(`   diagnostics: iframe=${g.iframe} /gsi/button=${buttonStatus} (not asserted)`);
  ok(!g.missing, 'the Google sign-in row is present');
  ok(g.ariaDisabled === null, `row is never aria-disabled (got ${g.ariaDisabled})`);
  ok(g.overlayPointerEvents !== 'none', `Google's button overlay still accepts clicks (got ${g.overlayPointerEvents})`);
  ok(!g.dimmed, 'row is not dimmed into looking dead');
}
console.log('\n================ '+(fail.length?`${fail.length} FAILING`:'ALL PASS')+' ================');
fail.forEach(f=>console.log('  x '+f));
await b.close();
process.exit(fail.length?1:0);
