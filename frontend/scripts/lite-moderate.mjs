#!/usr/bin/env node
// Operator CLI for lite-account moderation.
//
// There is no admin UI and no admin account model — the moderation endpoints are
// guarded by a shared secret, and this is the tool that holds it. Every action is
// recorded in lumen_moderation_action with the --actor label you pass.
//
//   LITE_MODERATOR_TOKEN=… node scripts/lite-moderate.mjs <command> [options]
//
// Commands:
//   suspend   <name|--id ULID>  --reason "…"  [--hide-content]
//   ban       <name|--id ULID>  --reason "…"  [--hide-content]
//   reinstate <name|--id ULID>                [--restore-content]
//   hide      <permlink|--id ULID> --reason "…" [--takedown]
//   quarantine <permlink|--id ULID> --reason "…"     (author_only)
//   unhide    <permlink|--id ULID>
//   log       [--target user|post] [--id ULID] [--limit N]
//
// Env: LUMEN_BASE_URL (default http://127.0.0.1:3000), LITE_MODERATOR_TOKEN.
//
// REMEMBER: hiding only changes what LUMEN shows. A post already on Hive stays on
// Hive until you pass --takedown, and even then Hive refuses a real delete once the
// post has replies or net-positive votes (the worker blanks it instead).

const BASE = process.env.LUMEN_BASE_URL || 'http://127.0.0.1:3000';
const TOKEN = process.env.LITE_MODERATOR_TOKEN || '';

if (!TOKEN) {
  console.error('LITE_MODERATOR_TOKEN is not set — refusing to run.');
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    positional.push(arg);
  }
}

const headers = {
  'content-type': 'application/json',
  'x-lite-moderator-token': TOKEN,
  'x-lite-moderator-actor': flags.actor || process.env.USER || 'operator'
};

const die = (message) => {
  console.error(message);
  process.exit(1);
};

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  console.log(res.status, JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
  return json;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const json = await res.json().catch(() => null);
  console.log(res.status, JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
  return json;
}

/** A user is named by display name, or by --id for the ULID. */
function userTarget() {
  if (flags.id) return { userId: flags.id };
  if (positional[0]) return { displayName: positional[0] };
  return die('Name the account: a display name, or --id <ULID>.');
}

/** A post is named by permlink (which encodes its row id), or by --id. */
function postTarget() {
  if (flags.id) return { postId: flags.id };
  if (positional[0]) return { permlink: positional[0] };
  return die('Name the post: a lumen-*/lite-* permlink, or --id <ULID>.');
}

function requireReason() {
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
  if (!reason) die('--reason is required: an action nobody can explain later is not a moderation action.');
  return reason;
}

switch (command) {
  case 'suspend':
  case 'ban':
    await post('/api/lite/moderation/user', {
      ...userTarget(),
      action: command,
      reason: requireReason(),
      // Omitted when the operator gave no flag, so the ROUTE's per-action default governs
      // (ban hides, suspend does not). `--hide-content` / `--no-hide-content` still win
      // explicitly. Sending a bare `false` here, as this did, meant a ban from the CLI
      // never hid anything even once the route learned to. JSON.stringify drops undefined.
      hideContent:
        flags['hide-content'] === true ? true : flags['no-hide-content'] === true ? false : undefined
    });
    break;

  case 'reinstate':
    await post('/api/lite/moderation/user', {
      ...userTarget(),
      action: 'reinstate',
      reason: typeof flags.reason === 'string' ? flags.reason : null,
      hideContent: flags['restore-content'] === true
    });
    break;

  case 'hide':
    await post('/api/lite/moderation/post', {
      ...postTarget(),
      visibility: 'hidden',
      reason: requireReason(),
      takedown: flags.takedown === true
    });
    break;

  case 'quarantine':
    await post('/api/lite/moderation/post', {
      ...postTarget(),
      visibility: 'author_only',
      reason: requireReason()
    });
    break;

  case 'unhide':
    await post('/api/lite/moderation/post', {
      ...postTarget(),
      visibility: 'visible',
      reason: typeof flags.reason === 'string' ? flags.reason : null
    });
    break;

  case 'log': {
    const params = new URLSearchParams();
    if (flags.target) params.set('targetType', String(flags.target));
    if (flags.id) params.set('targetId', String(flags.id));
    params.set('limit', String(flags.limit || 25));
    await get(`/api/lite/moderation/actions?${params}`);
    break;
  }

  default:
    console.log(
      [
        'Usage:',
        '  suspend    <name|--id ULID>     --reason "…" [--hide-content]',
        '  ban        <name|--id ULID>     --reason "…" [--hide-content]',
        '  reinstate  <name|--id ULID>                  [--restore-content]',
        '  hide       <permlink|--id ULID> --reason "…" [--takedown]',
        '  quarantine <permlink|--id ULID> --reason "…"',
        '  unhide     <permlink|--id ULID>',
        '  log        [--target user|post] [--id ULID] [--limit N]'
      ].join('\n')
    );
    process.exit(command ? 1 : 0);
}
