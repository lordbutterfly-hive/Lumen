// One-off (2026-09-23, owner: "fill those 13 as best as possible, with max you extracted
// with a + that's the max limit"). For every partial record, computes the missing figures
// in chunks that each fit the 300s cap, combines them exactly as the app would, and writes
// them back. A figure whose chunks did not all answer is written as a floor (flag -> "+").
const fs = require('fs'), path = require('path');
const L = require('/root/giants-lib.js');
const DIR = '/opt/lumen/cache';
const BUDGET_MS = Number(process.env.BUDGET_MS || 5 * 3600e3);
const WORKERS = 2, MAX_ITEMS = 20000;
const deadline = Date.now() + BUDGET_MS;
const log = (m) => fs.appendFileSync('/root/fill-giants.log', `${new Date().toISOString()} ${m}\n`);
const recPath = (a) => path.join(DIR, `rec-${a}.json`);
const readRec = (a) => JSON.parse(fs.readFileSync(recPath(a), 'utf8'));
function writeRec(a, patch) {
  const d = readRec(a);                       // latest copy, merged, never a stale overwrite
  Object.assign(d.record, patch);
  const r = d.record;
  const holes = r.steemPosts === null || r.downvotes === null || r.castVotes === null ||
    (r.removedFromOthersUsd === null && (r.castVotes || 0) > 0) || (r.removedUsd === null && (r.downvotes || 0) > 0);
  d.partial = holes;
  const tmp = recPath(a) + '.fg.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, recPath(a));
  return holes;
}
// Holds the app's per-account claim while we work, so a reader's refill does not race us.
function hold(a) { const f = path.join(DIR, `rec-${a}.lock`); const touch = () => { try { fs.closeSync(fs.openSync(f, 'a')); const t = new Date(); fs.utimesSync(f, t, t); } catch {} }; touch(); const h = setInterval(touch, 30000); return () => { clearInterval(h); const t = new Date(Date.now() - 3 * 60e3); try { fs.utimesSync(f, t, t); } catch {} }; }

async function steemWalk(account) {
  const ends = ['https://api.steemit.com', 'https://api.steem.fans'];
  const call = async (method, params) => { let last; for (const e of ends) { try { const res = await fetch(e, { method: 'POST', signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) }); const j = await res.json(); if (j.error) throw new Error('steem rpc error'); return j.result; } catch (err) { last = err; } } throw last; };
  const seen = new Set(); let posts = 0, lastPost = null, sa = '', sp = '';
  try {
    for (let page = 0; page < 40; page++) {
      const q = { tag: account, limit: 100 }; if (sp) { q.start_author = sa; q.start_permlink = sp; }
      const result = await call('condenser_api.get_discussions_by_blog', [q]);
      if (!Array.isArray(result) || result.length === 0) return { posts, lastPost, partial: false };
      const before = sp; let crossed = false;
      for (const p of result) {
        const key = `${p.author}/${p.permlink}`; if (seen.has(key)) continue; seen.add(key); sa = p.author; sp = p.permlink;
        if (p.author !== account) continue;
        if (p.created < '2020-03-20T14:00:00') { crossed = true; break; }
        if (p.created < '2020-09-20') continue;
        posts++; if (!lastPost || p.created > lastPost) lastPost = p.created;
      }
      if (crossed || result.length < 100 || sp === before) return { posts, lastPost, partial: false };
    }
    return { posts, lastPost, partial: true };
  } catch (err) {
    if (String(err).includes('steem rpc error')) { try { const f = await call('condenser_api.get_accounts', [[account]]); if (Array.isArray(f) && f.length === 0) return { posts: 0, lastPost: null, partial: false }; } catch {} }
    return posts > 0 ? { posts, lastPost, partial: true } : null;   // a floor if we counted anything
  }
}

(async () => {
  const targets = fs.readdirSync(DIR).filter((f) => /^rec-.*\.json$/.test(f)).map((f) => f.slice(4, -5))
    .filter((a) => { try { return readRec(a).partial === true; } catch { return false; } });
  log(`start: ${targets.length} partial records: ${targets.join(' ')}`);

  // 1) the old-country counts (external API, one at a time)
  for (const a of targets) {
    const r = readRec(a).record;
    if (r.steemPosts !== null) continue;
    const w = await steemWalk(a);
    if (w) { writeRec(a, { steemPosts: w.posts, steemPartial: w.partial, steemLastPost: w.lastPost }); log(`${a} old country ${w.posts}${w.partial ? '+' : ''}`); }
    else log(`${a} old country: still no answer`);
  }

  // 2) plan the SQL figures
  const c0 = await L.connect();
  const jobs = [];
  for (const a of targets) {
    const r = readRec(a).record;
    const needs = [];
    if (r.removedFromOthersUsd === null && (r.castVotes || 0) > 0) needs.push(['voter', 'removedFromOthersUsd', 'removedFromOthersFloor']);
    if (r.removedUsd === null && (r.downvotes || 0) > 0) needs.push(['author', 'removedUsd', 'removedUsdFloor']);
    for (const [kind, field, flag] of needs) {
      const plan = await L.run(c0, L.planSql(kind), [['v', 'VarChar', a]]);
      if (plan.error) { log(`${a} ${kind} plan failed: ${plan.error}`); continue; }
      const chunks = L.chunksFrom(plan.rows, MAX_ITEMS);
      const items = plan.rows.reduce((s, x) => s + x.n, 0);
      jobs.push({ a, kind, field, flag, chunks, items, parts: [], failed: 0, done: 0 });
      log(`${a} ${kind}: ${items} items in ${chunks.length} chunks`);
    }
  }
  c0.close();
  jobs.sort((x, y) => x.items - y.items);          // smallest first: those come out exact

  // 3) run every chunk, two at a time, smallest accounts first
  const queue = []; for (const j of jobs) for (const ch of j.chunks) queue.push([j, ch]);
  const release = new Map();
  const left = new Map(); for (const j of jobs) left.set(j.a, (left.get(j.a) || 0) + 1);
  const finish = (j) => {
    left.set(j.a, left.get(j.a) - 1);
    if (left.get(j.a) === 0 && release.has(j.a)) { release.get(j.a)(); release.delete(j.a); }
    const out = L.combine(j.parts);
    const floor = j.failed > 0 || j.done < j.chunks.length;
    if (out.value === null) { log(`${j.a} ${j.field}: nothing computable (${j.done}/${j.chunks.length} chunks)`); return; }
    const holes = writeRec(j.a, { [j.field]: out.value, [j.flag]: floor });
    log(`${j.a} ${j.field} = ${out.value.toFixed(2)}${floor ? '+' : ''} (${j.done}/${j.chunks.length} chunks, ${j.failed} failed)${holes ? ' [still partial]' : ''}`);
  };
  async function worker(id) {
    const c = await L.connect();
    while (queue.length && Date.now() < deadline) {
      const [j, ch] = queue.shift();
      if (!release.has(j.a)) release.set(j.a, hold(j.a));
      const r = await L.run(c, L.chunkSql(j.kind), [['v', 'VarChar', j.a], ['from', 'DateTime', new Date(ch.from)], ['to', 'DateTime', new Date(ch.to)]]);
      if (r.error) { j.failed++; log(`${j.a} ${j.kind} chunk ${new Date(ch.from).toISOString().slice(0, 10)} FAILED: ${r.error.slice(0, 80)}`); }
      else j.parts.push(r.rows);
      j.done++;
      if (j.done === j.chunks.length) { finish(j); j.finished = true; }
    }
    c.close();
  }
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
  for (const j of jobs) if (!j.finished) finish(j);   // out of budget: whatever answered, as a floor
  for (const [, rel] of release) rel();
  log('done');
})().catch((e) => { log('CRASH ' + (e && e.stack || e)); process.exit(1); });
