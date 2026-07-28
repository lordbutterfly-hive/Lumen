/**
 * Proves cross-tier following (migration 0017) and the lite profile (migration 0016)
 * against a REAL Postgres.
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-follow-profile-e2e.ts
 *
 * What matters here is that all three follow directions Hive cannot express actually
 * work, that a Hive-to-Hive follow is refused rather than quietly duplicated off
 * chain, and that an upgrade does not cost a user their followers.
 *
 * The chain existence check is stubbed through its injection seam, so this needs no
 * network — only Postgres.
 */

import { User } from '@smart-signer/types/common';
import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import * as follows from '../apps/blog/lib/lite/repositories/follow-repository';
import {
  followByName,
  followState,
  unfollowByName
} from '../apps/blog/lib/lite/social/follow-service';
import { setAccountExistenceCheck } from '../apps/blog/lib/lite/social/follow-actor';
import { sanitizeProfile } from '../apps/blog/lib/lite/profile/profile-service';
import { liteAccountAsProfile } from '../apps/blog/lib/lite/render/lite-account';

/** Stands in for a real Hive account, to prove the lite -> Hive direction. */
const REAL_HIVE_ACCOUNT = 'gtg';

// The chain lookup is stubbed rather than called: importing the real one drags in
// @hiveio/wax, which has no CJS export map and cannot be loaded outside the Next
// bundle. What is being proved here is the DECISION (a name that exists is followed,
// one that does not is refused), not Hive's account index.
setAccountExistenceCheck(async (name) => name === REAL_HIVE_ACCOUNT);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const created: string[] = [];

async function makeLiteUser(tag: string) {
  const displayName = `flw${tag}${Date.now().toString(36).slice(-6)}`.toLowerCase().slice(0, 16);
  const user = await users.createUser({ displayName });
  created.push(user.userId);
  const session = {
    isLoggedIn: true,
    username: displayName,
    userId: user.userId,
    account_tier: 'lite'
  } as unknown as User;
  return { ...user, displayName, session };
}

/** A full Hive login: no Lumen row, identified by name. */
function hiveSession(username: string): User {
  return { isLoggedIn: true, username, account_tier: 'full' } as unknown as User;
}

async function main(): Promise<void> {
  console.log('Lite follow + profile e2e\n');

  // ── 1. lite -> lite: the direction that already worked, still works. ────────
  console.log('1. lite follows lite');
  const alice = await makeLiteUser('a');
  const bob = await makeLiteUser('b');
  {
    const r = await followByName(alice.session, bob.displayName);
    check('follow accepted', r.ok && r.following);
    const state = await followState(alice.session, bob.displayName);
    check('state says following', state.lumenEdge && state.following);
    check('bob has 1 follower', (await follows.countFollowers({ userId: bob.userId })) === 1);
    check('alice follows 1', (await follows.countFollowing({ userId: alice.userId })) === 1);
  }

  // ── 2. lite -> real Hive account: previously impossible. ────────────────────
  console.log('\n2. lite follows a real Hive account');
  {
    const r = await followByName(alice.session, REAL_HIVE_ACCOUNT);
    check(`follow of @${REAL_HIVE_ACCOUNT} accepted`, r.ok && r.following, JSON.stringify(r));
    const state = await followState(alice.session, REAL_HIVE_ACCOUNT);
    check('state says following', state.lumenEdge && state.following);
    const edge = await query<{ followee_key: string }>(
      `SELECT followee_key FROM lumen_follow WHERE follower_user_id = $1 AND followee_hive IS NOT NULL`,
      [alice.userId]
    );
    check(
      'stored as a hive-name node',
      edge.rows[0]?.followee_key === `h:${REAL_HIVE_ACCOUNT}`,
      edge.rows[0]?.followee_key
    );
  }

  // ── 3. an account that does not exist is refused. ───────────────────────────
  console.log('\n3. following a name that exists nowhere');
  {
    const r = await followByName(alice.session, 'zzz-not-an-account-9x');
    check('refused', !r.ok && r.error === 'not_found', JSON.stringify(r));
  }

  // ── 4. Hive user -> lite user: the other previously-impossible direction. ───
  console.log('\n4. a full Hive user follows a lite user');
  {
    const carol = hiveSession('carol-hive-test');
    const r = await followByName(carol, bob.displayName);
    check('follow accepted', r.ok && r.following, JSON.stringify(r));
    const state = await followState(carol, bob.displayName);
    check('state says following', state.lumenEdge && state.following);
    check('bob now has 2 followers', (await follows.countFollowers({ userId: bob.userId })) === 2);
  }

  // ── 5. Hive -> Hive stays on chain. ────────────────────────────────────────
  console.log('\n5. a full Hive user follows another Hive account');
  {
    const carol = hiveSession('carol-hive-test');
    const r = await followByName(carol, REAL_HIVE_ACCOUNT);
    check('refused as a chain follow', !r.ok && r.error === 'use_chain_follow', JSON.stringify(r));
    const state = await followState(carol, REAL_HIVE_ACCOUNT);
    check('state stays out of the way', !state.lumenEdge && !state.following);
  }

  // ── 6. unfollow is a retraction the recsys feed can see. ───────────────────
  console.log('\n6. unfollow');
  {
    const before = await follows.listEdges(0, 1000);
    const beforeSeq = before.length ? before[before.length - 1].seq : 0;
    const r = await unfollowByName(alice.session, bob.displayName);
    check('unfollow accepted', r.ok && !r.following);
    check('state clears', !(await followState(alice.session, bob.displayName)).following);
    const after = await follows.listEdges(beforeSeq, 1000);
    const retraction = after.find(
      (e) => e.follower === `u:${alice.userId}` && e.followee === `u:${bob.userId}`
    );
    check('retraction appears on the delta feed', Boolean(retraction) && !retraction?.active);
    check('follower count back to 1', (await follows.countFollowers({ userId: bob.userId })) === 1);
  }

  // ── 7. re-following the same person reactivates one edge, never a duplicate. ─
  console.log('\n7. follow again after unfollow');
  {
    await followByName(alice.session, bob.displayName);
    const rows = await query(
      `SELECT 1 FROM lumen_follow WHERE follower_user_id = $1 AND followee_user_id = $2`,
      [alice.userId, bob.userId]
    );
    check('still exactly one row', rows.rows.length === 1);
    check('and it is active', (await followState(alice.session, bob.displayName)).following);
  }

  // ── 8. an upgrade must not cost anyone their followers. ────────────────────
  console.log('\n8. upgrade keeps the audience');
  {
    const dave = await makeLiteUser('d');
    await followByName(alice.session, dave.displayName);
    const hiveName = `${dave.displayName}x`.slice(0, 16);
    await users.markUpgraded(dave.userId, hiveName);
    await follows.absorbHiveActor(dave.userId, hiveName);

    check('follower survived the upgrade', (await follows.countFollowers({ userId: dave.userId })) === 1);
    // The same person, now reachable under the new name: resolving it must land on
    // the SAME node, not create a second one.
    const state = await followState(alice.session, hiveName);
    check('still following under the new name', state.lumenEdge && state.following);
  }

  // ── 9. a name that a Lumen user upgraded to is folded into their node. ──────
  console.log('\n9. an edge stored against a name is absorbed on upgrade');
  {
    const erin = await makeLiteUser('e');
    const takenName = `${erin.displayName}z`.slice(0, 16);
    // Someone followed the bare NAME before it belonged to a Lumen account.
    await query(
      `INSERT INTO lumen_follow (follower_user_id, followee_hive) VALUES ($1, $2)`,
      [alice.userId, takenName]
    );
    await users.markUpgraded(erin.userId, takenName);
    await follows.absorbHiveActor(erin.userId, takenName);

    const leftover = await query(`SELECT 1 FROM lumen_follow WHERE followee_hive = $1`, [takenName]);
    check('no name-keyed edge left behind', leftover.rows.length === 0);
    check('the edge now points at the user', (await follows.countFollowers({ userId: erin.userId })) === 1);
  }

  // ── 10. you cannot follow yourself. ────────────────────────────────────────
  console.log('\n10. self-follow');
  {
    const r = await followByName(alice.session, alice.displayName);
    check('refused', !r.ok && r.error === 'cannot_follow_self', JSON.stringify(r));
  }

  // ── 11. a signed-out visitor gets no state and cannot write. ───────────────
  console.log('\n11. signed out');
  {
    const r = await followByName(undefined, bob.displayName);
    check('follow refused', !r.ok && r.error === 'unauthorized');
    const state = await followState(undefined, bob.displayName);
    check('no state leaked', !state.lumenEdge && !state.following);
  }

  // ── 12. profile validation: hostile values are dropped, not stored. ────────
  console.log('\n12. profile validation');
  {
    const clean = sanitizeProfile({
      name: 'Alice',
      about: 'x'.repeat(500),
      website: 'javascript:alert(1)',
      profile_image: 'https://images.hive.blog/DQm/pic.png',
      cover_image: 'data:image/png;base64,AAAA',
      location: 'Zagreb'
    });
    check('javascript: URL dropped', clean.website === '');
    check('data: URL dropped', clean.cover_image === '');
    check('https URL kept', clean.profile_image === 'https://images.hive.blog/DQm/pic.png');
    check('about truncated', (clean.about ?? '').length === 200);
    check('plain text kept', clean.name === 'Alice' && clean.location === 'Zagreb');
  }

  // ── 13. the profile round-trips and reaches the rendered account. ──────────
  console.log('\n13. profile round-trip');
  {
    const saved = await users.updateProfile(
      bob.userId,
      sanitizeProfile({
        name: 'Bob Bobson',
        about: 'Writes things',
        profile_image: 'https://images.hive.blog/DQm/bob.png',
        website: 'https://example.com'
      })
    );
    check('saved', saved?.profile?.name === 'Bob Bobson');
    check('avatar column kept in step', saved?.avatarUrl === 'https://images.hive.blog/DQm/bob.png');

    const account = await liteAccountAsProfile(bob.displayName);
    check('rendered profile carries the picture', account?.profile?.profile_image === 'https://images.hive.blog/DQm/bob.png');
    check('rendered profile carries the bio', account?.profile?.about === 'Writes things');
    // Alice re-followed in step 7 and the Hive user followed in step 4.
    check('follower count is real, not zero', (account?.follow_stats?.follower_count ?? 0) === 2);
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  await query(`DELETE FROM lumen_follow WHERE follower_hive = $1`, ['carol-hive-test']).catch(
    () => undefined
  );
  for (const userId of created) {
    await query('DELETE FROM lumen_user WHERE user_id = $1', [userId]).catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
