// Chunked valuation of downvotes, reproducing lib/inquisition/vote-ledger.ts exactly:
// each chunk returns per-payout-month INGREDIENTS; combine() applies the app's rate
// ladder (month -> year -> whole corpus) over ALL chunks, so the sum equals the single
// whole-history query when every chunk answers, and is a floor ("+") when some do not.
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync('/opt/lumen/.env', 'utf8').split('\n').filter((l) => /^HIVESQL_/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const { Connection, Request, TYPES } = require('/opt/lumen/app/node_modules/.pnpm/tedious@20.0.0/node_modules/tedious');

function connect() {
  return new Promise((res, rej) => {
    const c = new Connection({ server: env.HIVESQL_SERVER || 'vip.hivesql.io', authentication: { type: 'default', options: { userName: env.HIVESQL_USER, password: env.HIVESQL_PASSWORD } }, options: { database: env.HIVESQL_DATABASE || 'DBHive', encrypt: true, trustServerCertificate: true, requestTimeout: 300000, rowCollectionOnRequestCompletion: true } });
    c.connect((e) => (e ? rej(e) : res(c)));
  });
}
function run(c, sql, params) {
  return new Promise((res) => {
    const r = new Request(sql, (e, n, rows) => res(e ? { error: e.message } : { rows: rows.map((row) => row.reduce((o, col) => ((o[col.metadata.colName] = col.value), o), {})) }));
    for (const [name, type, value] of params) r.addParameter(name, TYPES[type], value);
    c.execSql(r);
  });
}

const PAID_AT = "CASE WHEN c.last_payout < '2016-01-01' THEN DATEADD(day, 7, c.created) ELSE c.last_payout END";
// kind 'voter': what @v's downvotes took off the posts first downvoted in [from, to)
// kind 'author': what all downvotes took off @v's posts created in [from, to)
function chunkSql(kind) {
  const scope = kind === 'voter'
    ? `JOIN (SELECT v2.author, v2.permlink FROM TxVotes v2 WITH (NOLOCK)
             WHERE v2.voter = @v AND v2.weight < 0
             GROUP BY v2.author, v2.permlink
             HAVING MIN(v2.timestamp) >= @from AND MIN(v2.timestamp) < @to) AS tgt
         ON tgt.author = c.author AND tgt.permlink = c.permlink`
    : '';
  const where = kind === 'voter' ? '' : 'WHERE c.author = @v AND c.created >= @from AND c.created < @to';
  const share = kind === 'voter'
    ? "SUM(CASE WHEN j.voter = @v AND j.rshares < 0 THEN -CAST(j.rshares AS float) ELSE 0 END)"
    : "SUM(CASE WHEN j.rshares < 0 THEN -CAST(j.rshares AS float) ELSE 0 END)";
  return `WITH p AS (
    SELECT c.ID, ${PAID_AT} AS paid_at,
           SUM(CASE WHEN j.rshares > 0 THEN CAST(j.rshares AS float) ELSE 0 END) AS pos,
           SUM(CASE WHEN j.rshares < 0 THEN -CAST(j.rshares AS float) ELSE 0 END) AS neg,
           ${share} AS share,
           MAX(CAST(c.total_payout_value AS float) + CAST(c.curator_payout_value AS float)) AS payout
    FROM Comments c WITH (NOLOCK)
    ${scope}
    CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
    ${where}
    GROUP BY c.ID, c.last_payout, c.created
  )
  SELECT DATEPART(year, paid_at) * 100 + DATEPART(month, paid_at) AS ym,
         SUM(CASE WHEN pos - neg > 0 AND payout > 0 THEN payout ELSE 0 END) AS paid_payout,
         SUM(CASE WHEN pos - neg > 0 AND payout > 0 THEN pos - neg ELSE 0 END) AS paid_net,
         SUM(CASE WHEN pos - neg > 0 AND payout > 0 THEN payout * share / (pos - neg) ELSE 0 END) AS exact_sum,
         SUM(CASE WHEN NOT (pos - neg > 0 AND payout > 0) AND neg > 0 AND share > 0
                  THEN (CASE WHEN neg <= pos THEN neg ELSE pos END) * share / neg ELSE 0 END) AS flat_units,
         SUM(CASE WHEN share > 0 THEN 1 ELSE 0 END) AS counted
  FROM p GROUP BY DATEPART(year, paid_at) * 100 + DATEPART(month, paid_at)`;
}

function planSql(kind) {
  return kind === 'voter'
    ? `SELECT DATEPART(year, m) * 100 + DATEPART(month, m) AS ym, COUNT(*) AS n
       FROM (SELECT author, permlink, MIN(timestamp) AS m FROM TxVotes WITH (NOLOCK)
             WHERE voter = @v AND weight < 0 GROUP BY author, permlink) x
       GROUP BY DATEPART(year, m) * 100 + DATEPART(month, m)`
    : `SELECT DATEPART(year, created) * 100 + DATEPART(month, created) AS ym, COUNT(*) AS n
       FROM Comments WITH (NOLOCK) WHERE author = @v
       GROUP BY DATEPART(year, created) * 100 + DATEPART(month, created)`;
}

// Months -> [from, to) chunks of at most `max` items; a month bigger than that is cut into
// equal time slices.
function chunksFrom(months, max) {
  const out = [];
  let cur = null;
  const monthStart = (ym) => Date.UTC(Math.floor(ym / 100), (ym % 100) - 1, 1);
  const monthEnd = (ym) => Date.UTC(Math.floor(ym / 100), ym % 100, 1);
  for (const { ym, n } of months.sort((a, b) => a.ym - b.ym)) {
    if (n > max) {
      if (cur) { out.push(cur); cur = null; }
      const k = Math.ceil(n / max), s = monthStart(ym), e = monthEnd(ym);
      for (let i = 0; i < k; i++) out.push({ from: s + ((e - s) * i) / k, to: s + ((e - s) * (i + 1)) / k, n: Math.round(n / k) });
      continue;
    }
    if (cur && cur.n + n <= max && cur.to === monthStart(ym)) { cur.to = monthEnd(ym); cur.n += n; }
    else { if (cur) out.push(cur); cur = { from: monthStart(ym), to: monthEnd(ym), n }; }
  }
  if (cur) out.push(cur);
  return out;
}

// The app's ladder over every chunk that answered.
function combine(parts) {
  const m = new Map();
  for (const rows of parts) for (const r of rows) {
    const x = m.get(r.ym) || { pp: 0, pn: 0, ex: 0, fl: 0, counted: 0 };
    x.pp += r.paid_payout || 0; x.pn += r.paid_net || 0; x.ex += r.exact_sum || 0; x.fl += r.flat_units || 0; x.counted += r.counted || 0;
    m.set(r.ym, x);
  }
  const year = new Map(); let allP = 0, allN = 0;
  for (const [ym, x] of m) { const y = Math.floor(ym / 100); const t = year.get(y) || { p: 0, n: 0 }; t.p += x.pp; t.n += x.pn; year.set(y, t); allP += x.pp; allN += x.pn; }
  const rAll = allN > 0 ? allP / allN : null;
  // `unvalued` is removal that exists (a flattened post that had upvotes to take) but has no
  // rate anywhere in the corpus. A post with nothing to take (no upvotes) is a real 0, which
  // the app's SQL renders as NULL only because 0 x NULL is NULL.
  let value = 0, counted = 0, unvalued = 0;
  for (const [ym, x] of m) {
    counted += x.counted;
    value += x.ex;
    if (x.fl > 0) {
      const y = year.get(Math.floor(ym / 100));
      const r = x.pn > 0 ? x.pp / x.pn : y && y.n > 0 ? y.p / y.n : rAll;
      if (r !== null) value += r * x.fl;
      else unvalued += x.fl;
    }
  }
  if (counted === 0 || (unvalued > 0 && value === 0)) return { value: null, counted, unvalued };
  return { value, counted, unvalued };
}

module.exports = { connect, run, chunkSql, planSql, chunksFrom, combine };
