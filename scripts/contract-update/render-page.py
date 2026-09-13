#!/usr/bin/env python3
"""Render the Keychain signing page for a vsc.update_contract.

Everything the page needs is baked in here by prepare-update.sh - the storage
proof above all, which a browser cannot produce. The page's job is the part a
browser is uniquely good at: showing a human exactly what they are about to
sign, re-checking the facts that can go stale between preparation and the click,
and refusing rather than spending when one of them has.
"""
import argparse, html, json

p = argparse.ArgumentParser()
for f in ('out network net-id contract-id gql gateway fee account name description '
          'old-cid new-cid wasm-size proof-hash proof-sig proof-bv epoch').split():
    p.add_argument('--' + f, required=True)
a = p.parse_args()

# The custom_json payload, field for field as state-processing/system_txs.go
# TxUpdateContract marshals it. `owner` is DELIBERATELY ABSENT: the deployer only
# sets it when -owner is passed, and passing a wrong one reassigns the contract
# to somebody else. Omitted means "leave the owner alone".
tx = {
    "net_id": a.net_id,
    "id": a.contract_id,
    "name": a.name,
    "description": a.description,
    "runtime": "go",
    "code": a.new_cid,
    "storage_proof": {"hash": a.proof_hash, "signature": {"sig": a.proof_sig, "bv": a.proof_bv}},
}
ops = [
    ["custom_json", {"required_auths": [a.account], "required_posting_auths": [],
                     "id": "vsc.update_contract", "json": json.dumps(tx, separators=(',', ':'))}],
    ["transfer", {"from": a.account, "to": a.gateway, "amount": a.fee, "memo": ""}],
]
cfg = {"network": a.network, "gql": a.gql, "account": a.account, "contractId": a.contract_id,
       "oldCid": a.old_cid, "newCid": a.new_cid, "fee": a.fee, "epoch": int(a.epoch), "ops": ops}

HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign the Meritum contract update</title>
<style>
:root{color-scheme:dark;--bg:#0e1116;--card:#161b22;--line:#2b3340;--ink:#e6edf3;--dim:#9aa7b6;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#2f81f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px}
.wrap{max-width:780px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 10px;font-weight:600}
dl{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:0}dt{color:var(--dim)}dd{margin:0;word-break:break-all}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.old{color:var(--bad)}.new{color:var(--ok)}
.check{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line)}.check:last-child{border-bottom:0}
.dot{flex:0 0 16px;height:16px;border-radius:50%;background:#3a4351;margin-top:3px}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.check .t{flex:1}.check .d{color:var(--dim);font-size:13px}
button{font:600 15px/1 inherit;padding:13px 20px;border-radius:8px;border:1px solid var(--line);background:#21262d;color:var(--ink);cursor:pointer}
button.go{background:var(--accent);border-color:var(--accent);color:#fff;width:100%;padding:16px}
button:disabled{opacity:.45;cursor:not-allowed}
pre{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;max-height:240px;font-size:12px;margin:0}
.note{border-left:3px solid var(--warn);padding-left:12px;color:var(--dim);font-size:13.5px}
.big{font-size:17px;font-weight:600}summary{cursor:pointer;color:var(--dim);font-size:13px}
@media(max-width:560px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
</style></head><body><div class="wrap">
<h1>Sign the Meritum contract update</h1>
<p class="sub">One Hive transaction, two operations: the code swap and the __FEE__ fee. Your active key never leaves Keychain.</p>

<div class="card"><h2>What changes</h2>
<dl>
<dt>Contract</dt><dd class="mono">__CONTRACT__</dd>
<dt>Network</dt><dd>__NETWORK__</dd>
<dt>Owner / payer</dt><dd>@__ACCOUNT__</dd>
<dt>Code now</dt><dd class="mono old">__OLDCID__</dd>
<dt>Code after</dt><dd class="mono new">__NEWCID__ <span style="color:var(--dim)">(__SIZE__ bytes)</span></dd>
<dt>Name</dt><dd>__NAME__</dd>
<dt>Description</dt><dd>__DESC__</dd>
<dt>Cost</dt><dd class="big">__FEE__</dd>
</dl>
<p class="note" style="margin-top:14px">Name and description were read off the chain a moment ago and are sent back unchanged.
<code>update_contract</code> overwrites both unconditionally, so omitting them would blank a live contract's identity.
The owner field is deliberately absent, which means leave the owner alone.</p>
</div>

<div class="card"><h2>Checks, re-run against the live chain</h2><div id="checks"></div>
<p class="note" style="margin-top:12px">The storage proof is an aggregated signature from the storage providers elected in
<b>epoch __EPOCH__</b>, and the chain verifies it against the election live at the block this transaction lands in.
If an election has turned over since this page was prepared the update would fail while the __FEE__ transfer went through anyway.
That is why the epoch is checked here and why this button refuses rather than risking it.</p>
</div>

<div class="card"><h2>Sign</h2>
<button class="go" id="go" disabled>Checking...</button>
<div id="result" style="margin-top:14px"></div>
</div>

<details class="card"><summary>The exact operations Keychain will be asked to sign</summary>
<pre id="ops"></pre></details>
</div>
<script>
const CFG = __CFG__;
document.getElementById('ops').textContent = JSON.stringify(CFG.ops, null, 2);

const checksEl = document.getElementById('checks'), goEl = document.getElementById('go'), resEl = document.getElementById('result');
const state = {};
function row(id, title, detail, status) {
  let el = document.getElementById('chk-' + id);
  if (!el) {
    el = document.createElement('div'); el.className = 'check'; el.id = 'chk-' + id;
    el.innerHTML = '<div class="dot"></div><div class="t"><div class="ti"></div><div class="d"></div></div>';
    checksEl.appendChild(el);
  }
  el.querySelector('.dot').className = 'dot ' + (status || '');
  el.querySelector('.ti').textContent = title;
  el.querySelector('.d').textContent = detail;
}
async function gql(query, variables) {
  const r = await fetch(CFG.gql, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({query, variables})});
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  return j.data;
}
async function hive(method, params) {
  const r = await fetch('https://api.hive.blog', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', method, params, id:1})});
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// ★★★ KEYCHAIN IS INJECTED ASYNCHRONOUSLY, SO ONE CHECK ON LOAD RACES IT.
// The first version of this page tested `window.hive_keychain` once at script
// end and then not again for 60 seconds, so a browser WITH Keychain installed
// sat on "Hive Keychain not found" for a full minute and looked broken. The
// app's own detector already carries this scar - features/lite-auth/login/
// keychain-signin.tsx: "Extensions inject after load; one check on mount can
// race them" - and re-checks at 1200ms. This polls instead, because a fixed
// delay is a guess about somebody else's startup time.
//
// The shape test is the defensive one from packages/smart-signer/lib/signer/
// signer-keychain.ts: page content like `<a id="hive_keychain">` would shadow
// the extension object, so "the property exists" is not the question. The
// question is whether the FUNCTION THIS PAGE CALLS is there.
function keychain() {
  const k = window.hive_keychain;
  return (typeof k === 'object' && k !== null && typeof k.requestBroadcast === 'function') ? k : null;
}
const KC_DEADLINE = Date.now() + 15000;
function pollKeychain() {
  if (keychain()) {
    row('kc','Hive Keychain is available','requestBroadcast will be used, with Active authority','ok');
    runChecks();
    return;
  }
  if (Date.now() < KC_DEADLINE) {
    row('kc','Looking for Hive Keychain...','Extensions inject after page load, so this waits up to 15 seconds','warn');
    setTimeout(pollKeychain, 250);
    return;
  }
  row('kc','Hive Keychain not found','Checked for 15 seconds. It must be ENABLED for this site: some builds ask per-site, and http:// pages are the usual thing they are not enabled for. Open the extension, allow this origin, then reload. A file:// URL never works - Keychain injects on http(s) only.','bad');
  runChecks();
}

async function runChecks() {
  state.ok = true;
  const fail = (id,t,d) => { row(id,t,d,'bad'); state.ok = false; };

  // 1. Keychain present - the row is owned by pollKeychain above; this only
  //    decides whether the button may enable.
  if (!keychain()) { state.ok = false; }

  // 2. The chain still runs the code we think it does.
  try {
    const d = await gql('query($id:String!){findContract(filterOptions:{byId:$id}){id code name description owner}}', {id: CFG.contractId});
    const row0 = (d.findContract||[]).find(r => r.id === CFG.contractId);
    if (!row0) fail('chain','The chain does not know this contract', CFG.contractId);
    else if (row0.code === CFG.newCid) fail('chain','Already deployed','The chain is already running ' + CFG.newCid + '. There is nothing to pay for.');
    else if (row0.code !== CFG.oldCid) fail('chain','The deployed code moved since this page was prepared','now ' + row0.code + ', expected ' + CFG.oldCid + '. Re-run prepare-update.sh.');
    else row('chain','The chain still runs the expected code', row0.code, 'ok');
  } catch (e) { fail('chain','Could not read the contract', String(e.message||e)); }

  // 3. The election has not turned over. THE ONE THAT COSTS MONEY IF IGNORED.
  try {
    const d = await gql('{electionByBlockHeight{epoch block_height}}');
    const now = d.electionByBlockHeight.epoch;
    if (now === CFG.epoch) row('epoch','Election unchanged since the proof was made','epoch ' + now, 'ok');
    else fail('epoch','THE ELECTION HAS MOVED - the storage proof is stale','prepared under epoch ' + CFG.epoch + ', chain is on ' + now + '. Broadcasting now would fail the update AND still pay the fee. Re-run prepare-update.sh.');
  } catch (e) { fail('epoch','Could not read the election', String(e.message||e)); }

  // 4. The payer can pay.
  try {
    const acc = (await hive('condenser_api.get_accounts', [[CFG.account]]))[0];
    const hbd = parseFloat(acc.hbd_balance);
    const need = parseFloat(CFG.fee);
    if (hbd >= need) row('bal','@' + CFG.account + ' can pay the fee', acc.hbd_balance + ' available, ' + CFG.fee + ' needed', 'ok');
    else fail('bal','@' + CFG.account + ' cannot pay the fee', acc.hbd_balance + ' available, ' + CFG.fee + ' needed. Top the account up and reload.');
  } catch (e) { fail('bal','Could not read the account balance', String(e.message||e)); }

  goEl.disabled = !state.ok;
  if (state.ok) goEl.textContent = 'Sign and broadcast - pay ' + CFG.fee;
  else if (!keychain() && Date.now() < KC_DEADLINE) goEl.textContent = 'Looking for Keychain...';
  else goEl.textContent = 'Blocked - see the checks above';
}

goEl.addEventListener('click', () => {
  goEl.disabled = true; goEl.textContent = 'Waiting for Keychain...';
  resEl.innerHTML = '<div class="note">Approve the transaction in the Keychain popup. It carries BOTH operations.</div>';
  keychain().requestBroadcast(CFG.account, CFG.ops, 'Active', async (r) => {
    if (!r.success) {
      resEl.innerHTML = '<div class="check"><div class="dot bad"></div><div class="t"><div class="big">Not broadcast</div><div class="d">' +
        (r.message || 'Keychain refused or you cancelled') + '</div></div></div>';
      goEl.disabled = false; goEl.textContent = 'Try again';
      return;
    }
    const txid = (r.result && (r.result.id || r.result.tx_id)) || '(see Keychain)';
    resEl.innerHTML = '<div class="check"><div class="dot ok"></div><div class="t"><div class="big">Broadcast</div>' +
      '<div class="d mono">tx ' + txid + '</div></div></div>' +
      '<div id="verify" class="note" style="margin-top:12px">Now verifying the code actually swapped. A green transaction is not a deployed contract.</div>';
    goEl.textContent = 'Broadcast - verifying';
    // ★ VERIFY THE CODE, NOT THE TX. update_contract can be accepted on Hive and
    // still fail inside the state engine (a bad proof does exactly that), so the
    // only answer that means anything is the contract's own code CID read back.
    for (let i = 1; i <= 40; i++) {
      await new Promise(s => setTimeout(s, 3000));
      try {
        const d = await gql('query($id:String!){findContract(filterOptions:{byId:$id}){id code}}', {id: CFG.contractId});
        const c = (d.findContract||[]).find(x => x.id === CFG.contractId);
        if (c && c.code === CFG.newCid) {
          document.getElementById('verify').outerHTML =
            '<div class="check"><div class="dot ok"></div><div class="t"><div class="big">Deployed and verified</div>' +
            '<div class="d mono">code is now ' + c.code + '</div></div></div>';
          goEl.textContent = 'Done';
          return;
        }
        document.getElementById('verify').textContent = 'Verifying... attempt ' + i + '/40, chain still reports ' + (c ? c.code : 'nothing');
      } catch (e) { /* keep polling */ }
    }
    document.getElementById('verify').outerHTML =
      '<div class="check"><div class="dot warn"></div><div class="t"><div class="big">Transaction went out, code has NOT swapped yet</div>' +
      '<div class="d">Two minutes of polling and the chain still reports the old CID. Either it is slow, or the state engine rejected it (a stale storage proof does exactly this, and the fee is spent either way). Check the contract before paying again.</div></div></div>';
  });
});

pollKeychain();
runChecks();
setInterval(runChecks, 60000);
</script></body></html>
"""

out = (HTML
   .replace('__CFG__', json.dumps(cfg))
   .replace('__CONTRACT__', html.escape(a.contract_id))
   .replace('__NETWORK__', html.escape(a.network))
   .replace('__ACCOUNT__', html.escape(a.account))
   .replace('__OLDCID__', html.escape(a.old_cid))
   .replace('__NEWCID__', html.escape(a.new_cid))
   .replace('__SIZE__', html.escape(a.wasm_size))
   .replace('__NAME__', html.escape(a.name))
   .replace('__DESC__', html.escape(a.description))
   .replace('__EPOCH__', html.escape(a.epoch))
   .replace('__FEE__', html.escape(a.fee)))
open(a.out, 'w', encoding='utf-8').write(out)
print(f"     {a.out}  ({len(out)} bytes)")
