// The "test file" for this feature's contract/wrapper payload shapes.
//
// apps/blog has no unit test runner wired (verified 2026-07-20: no jest or
// vitest config/devDependency anywhere in this repo; turbo.json declares a
// `test:jest` pipeline task but no package.json anywhere implements it;
// packages/ui/**/*.test.ts and packages/renderer/**/*.test.ts exist, but
// packages/ui has no "test" script or runner attached at all, and
// packages/renderer's mocha suite — the one unit runner actually wired into
// CI, gitlab-ci.yml's `renderer-unit-tests` job — is scoped to that package
// only. apps/blog's only test tooling is Playwright E2E
// (apps/blog/playwright/**), which spins up a browser against a running dev
// server — the wrong shape for a static payload-format assertion, and
// apps/blog/tsconfig.json explicitly excludes the playwright/ directory from
// its own typecheck). Per the task brief's fallback for "genuinely no
// runner": this is a plain exported checker (runPayloadContractSelfTest),
// called automatically in development (see the bottom of this file) rather
// than relying on a `*.test.ts` naming convention nothing would execute —
// that would be dead weight, worse than being honest about the gap (see
// CLAUDE.md: "no fake wired modules").
//
// WHAT THIS PROVES: one representative payload per write action, built via
// the SAME pure builder functions vsc-data-source.ts's real write methods
// call (op-builders.ts's registerPayload/renewPayload/.../
// transferCreditsPayload — never a hand-duplicated fixture that could drift
// from the real code), checked against ACTION_PAYLOAD_SPECS
// (payload-contract.ts) via the same assertPayloadShape() buildOp() calls on
// every real write. A rename in either the builder or the spec — the exact
// bug class this whole file exists to catch — throws HERE, at import time,
// before a single byte reaches the chain.
//
// HOW TO RUN IT BY HAND (no runner needed — this file has zero framework
// imports): `npx tsx apps/blog/features/creator-tokens/lib/vsc/payload-contract.selftest.ts`
// from the repo root. It also runs itself automatically in development —
// see the bottom of this file.

import { ACTION_PAYLOAD_SPECS, assertPayloadShape } from './payload-contract';
import {
  answerPayload,
  askPayload,
  buildOp,
  buyPayload,
  claimTradeFeesPayload,
  closeIfDrainedPayload,
  createOfferingPayload,
  declinePayload,
  deleteOfferingPayload,
  pausePayload,
  ratePayload,
  reclaimPayload,
  refundHolderPayload,
  refundPayload,
  registerPayload,
  renewPayload,
  retirePayload,
  sellPayload,
  setCapPayload,
  setFacePayload,
  setOfferingPricePayload,
  setOfferingTitlePayload,
  transferTokensPayload,
  unpausePayload,
  withdrawTreasuryPayload
} from './op-builders';

interface Case {
  action: string;
  payload: Record<string, unknown>;
}

function representativeCases(): Case[] {
  return [
    // Registration is FREE now — no feePaid. Both the plain and the
    // optional-firstBuy shapes are covered, because the optional key is
    // exactly where an "omit vs send" mistake would hide.
    { action: 'register', payload: registerPayload(2_500, 1_000) },
    { action: 'register', payload: registerPayload(2_500, 1_000, 25) },
    { action: 'renew', payload: renewPayload('alice', 3, 30_000) },
    { action: 'setFace', payload: setFacePayload(3_000) },
    { action: 'setCap', payload: setCapPayload(2_000) },
    // The curve rails. Both optional-minNet shapes, same reasoning as above.
    { action: 'buy', payload: buyPayload('alice', 25) },
    { action: 'sell', payload: sellPayload('alice', 10) },
    { action: 'sell', payload: sellPayload('alice', 10, 9_500) },
    // BOTH ask shapes: without an offeringId (the legacy face price, where the
    // key must be OMITTED entirely, not sent as 0) and with one (the shop).
    // Omit-vs-send on this optional key is exactly where the shop would break.
    { action: 'ask', payload: askPayload('alice', 'Qm-some-content-hash', 28_800, 5_000) },
    { action: 'ask', payload: askPayload('alice', 'Qm-some-content-hash', 28_800, 5_000, 3) },
    { action: 'answer', payload: answerPayload(7, 'Qm-some-answer-hash') },
    { action: 'decline', payload: declinePayload('alice', 7) },
    // The offerings shop. Prices here are UNQUOTED numbers, unlike every money
    // field above — a quoted string would post a FREE service (see the shop
    // section of op-builders.ts).
    { action: 'createOffering', payload: createOfferingPayload('15-minute call', 200_000) },
    { action: 'setOfferingPrice', payload: setOfferingPricePayload(3, 250_000) },
    { action: 'setOfferingTitle', payload: setOfferingTitlePayload(3, '20-minute call') },
    { action: 'deleteOffering', payload: deleteOfferingPayload(3) },
    { action: 'reclaim', payload: reclaimPayload('alice', 7) },
    { action: 'rate', payload: ratePayload('alice', 7, 5) },
    { action: 'refund', payload: refundPayload('alice', 15) },
    { action: 'refund', payload: refundPayload('alice', 15, 1_200) },
    { action: 'refundHolder', payload: refundHolderPayload('alice', 'bob') },
    { action: 'transfer', payload: transferTokensPayload('alice', 'bob', 5) },
    { action: 'retire', payload: retirePayload('alice') },
    { action: 'claimTradeFees', payload: claimTradeFeesPayload() },
    { action: 'closeIfDrained', payload: closeIfDrainedPayload('alice') },
    { action: 'withdrawTreasury', payload: withdrawTreasuryPayload(50_000) },
    { action: 'pause', payload: pausePayload() },
    { action: 'unpause', payload: unpausePayload() }
  ];
}

/**
 * Runs assertPayloadShape against one representative payload per write
 * action, built through the real op-builders.ts functions. Throws a single
 * combined Error naming every action that failed if any mismatch is found;
 * otherwise returns silently. Exported so this can be invoked from anywhere
 * (a future test runner, a manual `npx tsx` run, or the dev-mode
 * self-invocation at the bottom of this file).
 */
export function runPayloadContractSelfTest(): void {
  const failures: string[] = [];
  for (const { action, payload } of representativeCases()) {
    try {
      assertPayloadShape(action, payload);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(`creator-tokens payload-contract self-test FAILED:\n- ${failures.join('\n- ')}`);
  }
}

/**
 * Cross-checks representativeCases() against ACTION_PAYLOAD_SPECS's own key
 * set, so a new action added to only one side (a new write wired into
 * op-builders.ts with no matching spec entry, or a spec entry with nothing
 * exercising it) is caught too — runPayloadContractSelfTest alone would
 * silently just not test an uncovered action rather than flag the gap.
 */
export function assertSelfTestCoversEverySpecAction(): void {
  const covered = new Set(representativeCases().map((c) => c.action));
  const specActionNames = Object.keys(ACTION_PAYLOAD_SPECS);
  const missing = specActionNames.filter((name) => !covered.has(name));
  const extra = [...covered].filter((name) => !specActionNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`ACTION_PAYLOAD_SPECS has ${missing.join(', ')} with no representative case in payload-contract.selftest.ts`);
    if (extra.length > 0) parts.push(`payload-contract.selftest.ts has a case for ${extra.join(', ')} with no matching ACTION_PAYLOAD_SPECS entry`);
    throw new Error(`creator-tokens payload-contract self-test coverage gap: ${parts.join('; ')}`);
  }
}

/**
 * Finding C1 (posting-key-theft fix): builds a real CustomJsonOp via
 * buildOp() — not just the bare payload — for every representative write
 * action, with a placeholder active-auth signer, and confirms the result
 * carries active authority ONLY (never posting). buildOp() already calls
 * payload-contract.ts's assertAuthContract() internally in development, so
 * this call alone is enough to catch a regression in that function; it is
 * kept as its own check (rather than folded into
 * runPayloadContractSelfTest) so a future auth-only regression reports
 * under its own clearly-labelled failure rather than being lumped in with a
 * payload-shape violation.
 */
export function runAuthContractSelfTest(): void {
  const failures: string[] = [];
  for (const { action, payload } of representativeCases()) {
    try {
      const op = buildOp({ netId: 'selftest-net', contractId: 'selftest-contract', action, payload, activeAuth: 'hive:selftest-signer' });
      if (op.required_auths.length === 0 || op.required_posting_auths.length !== 0) {
        failures.push(
          `action "${action}" built an op with required_auths=${JSON.stringify(op.required_auths)} required_posting_auths=${JSON.stringify(op.required_posting_auths)} — every creator-tokens write must carry ACTIVE authority only`
        );
      }
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failures.length > 0) {
    throw new Error(`creator-tokens auth-contract self-test FAILED:\n- ${failures.join('\n- ')}`);
  }
}

// Dev-mode self-invocation: run all three checks the moment this module
// loads in a non-production build. vsc-data-source.ts imports this file for
// its side effect (see the top of that file) — deliberately from
// vsc-data-source.ts, one layer ABOVE op-builders.ts, never from
// op-builders.ts itself: this file also imports FROM op-builders.ts, so
// having op-builders.ts import back from here would be a circular import.
// The one-directional edge (vsc-data-source.ts -> this file -> op-builders.ts)
// means any page/hook that reaches vsc-data-source.ts pulls this in
// transitively, so a rename/auth regression fails at app startup, not only
// when a specific write action happens to be exercised.
if (process.env.NODE_ENV !== 'production') {
  runPayloadContractSelfTest();
  assertSelfTestCoversEverySpecAction();
  runAuthContractSelfTest();
}
