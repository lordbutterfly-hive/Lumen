// The account lists the Inquisition warm pass builds records for, beyond the boards, so a
// profile is warm BEFORE anyone opens it (owner, 2026-09-23). One statement at a time.
//
//   whale-accounts.txt   every account that EVER held 100k+ HP/SP, Steem history included:
//                        A  holds 100k+ HP now;
//                        B  started a single power-down worth 100k+ at that month's rate
//                           (you can only power down what you hold);
//                        C  powered down 100k+ in total (catches whales who cashed out in
//                           smaller steps; may include a few who never held 100k at once);
//                        D  held 100k+ at the 2020 fork but was left out of the Hive airdrop.
//   active-accounts.txt  every account that posted or commented in the last ACTIVE_DAYS,
//                        most recently active first: the authors a reader clicks through to.
//
// On any failure the previous files are kept.
const fs = require('fs');
const DAYS = Number(process.env.ACTIVE_DAYS || 30);
const MIN_HP = Number(process.env.WHALE_MIN_HP || 100000);
const DIR = process.env.LUMEN_CACHE_DIR || '/opt/lumen/cache';
const env = Object.fromEntries(fs.readFileSync('/opt/lumen/.env', 'utf8').split('\n').filter((l) => /^HIVESQL_/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
const { Connection, Request, TYPES } = require('/opt/lumen/app/node_modules/.pnpm/tedious@20.0.0/node_modules/tedious');

const RATE = `rate AS (
  SELECT DATEPART(year, timestamp) * 100 + DATEPART(month, timestamp) AS ym,
         SUM(CAST(deposited AS float)) / NULLIF(SUM(CAST(withdrawn AS float)), 0) AS r
  FROM VOFillVestingWithdraws WITH (NOLOCK)
  WHERE deposited_symbol <> 'VESTS' AND withdrawn > 0
  GROUP BY DATEPART(year, timestamp) * 100 + DATEPART(month, timestamp)),
r0 AS (SELECT TOP 1 r FROM rate ORDER BY ym)`;

const JOBS = [
  {
    out: 'whale-accounts.txt',
    sql: `WITH ${RATE}
      SELECT name FROM Accounts WITH (NOLOCK)
        WHERE CAST(vesting_shares AS float) * (SELECT TOP 1 CAST(hive_per_vest AS float) FROM DynamicGlobalProperties) >= @min
      UNION
      SELECT t.account FROM TxWithdraws t WITH (NOLOCK)
        LEFT JOIN rate ON rate.ym = DATEPART(year, t.timestamp) * 100 + DATEPART(month, t.timestamp)
        CROSS JOIN r0
        WHERE t.vesting_shares > 0
        GROUP BY t.account
        HAVING MAX(CAST(t.vesting_shares AS float) * COALESCE(rate.r, r0.r)) >= @min
      UNION
      SELECT from_account FROM VOFillVestingWithdraws WITH (NOLOCK)
        WHERE deposited_symbol <> 'VESTS'
        GROUP BY from_account HAVING SUM(CAST(deposited AS float)) >= @min
      UNION
      SELECT account FROM VOHardforkHives WITH (NOLOCK)
        WHERE CAST(total_steem_from_vests AS float) >= @min`,
    params: (r) => r.addParameter('min', TYPES.Float, MIN_HP)
  },
  {
    out: 'active-accounts.txt',
    sql: `SELECT name FROM Accounts WITH (NOLOCK)
      WHERE last_post > DATEADD(day, -@days, GETUTCDATE())
      ORDER BY last_root_post DESC, last_post DESC`,
    params: (r) => r.addParameter('days', TYPES.Int, DAYS)
  }
];

const c = new Connection({ server: env.HIVESQL_SERVER || 'vip.hivesql.io', authentication: { type: 'default', options: { userName: env.HIVESQL_USER, password: env.HIVESQL_PASSWORD } }, options: { database: env.HIVESQL_DATABASE || 'DBHive', encrypt: true, trustServerCertificate: true, requestTimeout: 280000, rowCollectionOnRequestCompletion: true } });
let failed = false;
c.connect((err) => {
  if (err) { console.error('warm-accounts: connect failed:', err.message); process.exit(1); }
  run(0);
});
function run(i) {
  if (i >= JOBS.length) { c.close(); process.exit(failed ? 1 : 0); }
  const job = JOBS[i];
  const r = new Request(job.sql, (e, n, rows) => {
    const names = e ? [] : rows.map((row) => String(row[0].value)).filter((s) => /^[a-z0-9.-]{3,16}$/.test(s));
    if (e || names.length === 0) {
      failed = true;
      console.error(`warm-accounts: ${job.out} not refreshed (${e ? e.message.slice(0, 160) : 'empty answer'}); keeping the previous list`);
    } else {
      fs.writeFileSync(`${DIR}/${job.out}.tmp`, names.join('\n') + '\n');
      fs.renameSync(`${DIR}/${job.out}.tmp`, `${DIR}/${job.out}`);
      console.log(`warm-accounts: ${job.out} ${names.length} accounts`);
    }
    run(i + 1);
  });
  job.params(r);
  c.execSql(r);
}
