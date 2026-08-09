/**
 * Broadcast a real creator-tokens write to Magi testnet from this box.
 *
 * Why this exists: the repo has NO live submitter — `keeper.LiveSubmitter` is an
 * explicit stub, and the RUNBOOK records that "real Hive transaction
 * signing/broadcast" was deliberately never built. So every chain write behind
 * the one live market was made by hand, and the path this file exercises has
 * never been proven from this machine.
 *
 * The envelope is not invented here: it is the same one the frontend builds
 * (`features/creator-tokens/lib/vsc/op-builders.ts`) — `custom_json` id
 * `vsc.call`, body `{net_id, contract_id, action, payload, rc_limit, intents}`,
 * `required_auths: [signer]`, `required_posting_auths: []`. Creator-token writes
 * need ACTIVE authority; a posting key is refused on chain.
 *
 *   node qa/harness/ct-broadcast.mjs                 # DRY RUN — prints, sends nothing
 *   node qa/harness/ct-broadcast.mjs --broadcast     # actually signs and sends
 *
 * Dry run is the default on purpose: this spends real resource credits and
 * mutates real contract state.
 */
import { readFileSync } from 'node:fs';
import { createHiveChain } from '@hiveio/wax';
import createBeekeeper from '@hiveio/beekeeper';
import { BeekeeperProvider } from '@hiveio/wax-signers-beekeeper';

const CONTRACT = 'vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8';
const NET_ID = 'vsc-testnet';
const API = 'https://testnet.techcoderx.com';
const CHAIN_ID = '18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e';
const SIGNER = 'magi.contracts';
const VSC_CALL_ID = 'vsc.call';
const RC_LIMIT = Number(process.env.CT_RC_LIMIT ?? 1000);

const BROADCAST = process.argv.includes('--broadcast');

/** Active key for the signer — read from disk, never printed. */
function activeKey() {
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/deploy-testnet/config/hiveConfig.json`, 'utf8'));
  const key = cfg.activeKey;
  if (!key) throw new Error('no activeKey in ~/deploy-testnet/config/hiveConfig.json');
  return key;
}

/**
 * The services to post on the existing `magi.contracts` market.
 *
 * `price` is UNQUOTED base units, not a money string — the shop entrypoints read
 * it with the loose number reader (`jsonU64`), so "2500" as a string would parse
 * as 0 and post a FREE service. 1000 base units = 1.000 HBD/USD.
 */
const OFFERINGS = [{ title: process.env.CT_TITLE ?? 'Code review', price: 25000 }];

function buildOp(action, payload) {
  return {
    id: VSC_CALL_ID,
    json: JSON.stringify({
      net_id: NET_ID,
      contract_id: CONTRACT,
      action,
      payload,
      rc_limit: RC_LIMIT,
      intents: []
    }),
    required_auths: [SIGNER],
    required_posting_auths: []
  };
}

const ops = OFFERINGS.map((o) => buildOp('createOffering', { title: o.title, price: o.price }));

console.log(`${BROADCAST ? 'BROADCAST' : 'DRY RUN'} — ${ops.length} op(s) as @${SIGNER} on ${NET_ID}\n`);
for (const op of ops) {
  console.log(`  id=${op.id}  required_auths=${JSON.stringify(op.required_auths)}`);
  console.log(`  json=${op.json}\n`);
}

if (!BROADCAST) {
  console.log('Nothing sent. Re-run with --broadcast to sign and submit.');
  process.exit(0);
}

const chain = await createHiveChain({ apiEndpoint: API, chainId: CHAIN_ID });

// In-memory wallet: the WIF is never written to beekeeper's storage root.
const beekeeper = await createBeekeeper({ inMemory: true });
const session = beekeeper.createSession('ct-broadcast');
const { wallet } = await session.createWallet('ct-broadcast', undefined, true);
const publicKey = await wallet.importKey(activeKey());

// ★ Same safety the lite publisher applies before it will sign anything: prove
// the key we hold really is in this account's ACTIVE authority. Creator-token
// writes are gated on `requireActiveAuth` on chain, so signing with anything
// else would burn RC to produce a transaction the contract must reject — and
// the failure would look like a contract bug rather than a key mix-up.
const accounts = await chain.api.database_api.find_accounts({ accounts: [SIGNER] });
const found = accounts.accounts?.[0];
if (!found) throw new Error(`@${SIGNER} does not exist on ${API}`);
const activeKeys = (found.active?.key_auths ?? []).map((a) => String(a[0]));
if (!activeKeys.includes(publicKey)) {
  throw new Error(
    `the key we hold (${publicKey}) is NOT in @${SIGNER}'s active authority — refusing to broadcast`
  );
}
console.log(`signer verified: @${SIGNER} active key ${publicKey}\n`);

// `for(chain, wallet, account, role)` — role 'active', matching the authority
// verified above and the one every creator-token write requires on chain.
const signer = await BeekeeperProvider.for(chain, wallet, SIGNER, 'active');
for (const op of ops) {
  const title = JSON.parse(op.json).payload.title;
  try {
    const tx = await chain.createTransaction();
    tx.pushOperation({ custom_json_operation: op });
    tx.validate();
    await signer.signTransaction(tx);
    await chain.broadcast(tx);
    console.log(`broadcast OK — createOffering "${title}"  tx ${tx.id}`);
  } catch (error) {
    console.log(`broadcast FAILED — "${title}" — ${String(error).slice(0, 260)}`);
    process.exitCode = 1;
  }
}
