/**
 * The op list for a ONE-SIGNATURE Meritum launch, built as a pure function so
 * the exact bytes that get broadcast are the exact bytes a test can assert.
 *
 * ★★★ WHY THIS IS ITS OWN PURE MODULE (2026-09-04, one-signature launch rework).
 *
 * A one-signature launch is a single Hive transaction whose ops are, IN ORDER:
 *
 *   op 0  register        (face, cap, and the optional creator first-buy)
 *   op 1  createOffering   (the first configured service)
 *   ...
 *   op N  createOffering   (the Nth configured service)
 *
 * The whole tx is ATOMIC on chain (`state_engine.go:2241-2390`: any op failing
 * reverts the whole tx; nothing lands, nothing is charged for a market), and the
 * ops share one execution session in order (op 1 sees the market op 0 created).
 * That is only safe if what we sign is EXACTLY what the terms screen disclosed —
 * one register with the shown face/cap/first-buy and exactly the configured
 * offerings, in order, with no extra, injected, reordered or mutated op, and with
 * the first-buy HBD leg carried ONLY by register (never duplicated onto an
 * offering). Building the list in one pure function, with no network and no
 * class state, is what makes that guarantee testable: `launch-ops.test.ts`
 * asserts the returned list matches a configured launch 1:1, and
 * `vsc-data-source.ts`'s `launchMarket` broadcasts THIS SAME list — so the
 * disclosed launch and the broadcast launch cannot drift.
 *
 * ★ IT REUSES THE EXISTING OP-BUILDERS, byte-for-byte. `register` is built with
 * `registerPayload` + the same first-buy quote (`quoteBuyBaseUnits(0, …)`) and
 * the same `hbdLegBaseUnits` intent that `VscCreatorTokensDataSource.registerMarket`
 * uses for a standalone register; each offering with `createOfferingPayload` +
 * `buildOp`, exactly as `createOffering` does. No second wire shape is invented
 * here — see op-builders.ts's file doc, which is the one place the payload/auth
 * contract lives.
 *
 * ★ EVERY OFFERING IS VALIDATED HERE, not just the first (item D, refined for
 * atomicity). A single bad offering (a title the contract's `validOfferTitle`
 * refuses, or a non-positive price) reverts the WHOLE atomic launch AFTER the
 * creator has signed and waited — so a doomed op must be caught locally, before
 * anything is signed. `createOfferingPayload` -> `assertValidOfferTitle` throws
 * on a bad title, and the price guard throws on a non-positive price; the throw
 * carries the offering's own index so the caller can point at it. Nothing is
 * broadcast if any op cannot be built.
 *
 * Pure: imports only the (equally pure) op-builders and contract-math. No React,
 * no `@/blog/*` path aliases, no network — so it runs under plain ts-node the way
 * lib/post/threespeak-embed.test.ts does.
 */

import type { CreateOfferingInput, RegisterMarketInput } from '../../types';
import {
  MAX_CAP_CREDITS_BASE_UNITS,
  MAX_FACE_BASE_UNITS,
  MIN_CAP_CREDITS_BASE_UNITS,
  MIN_FACE_BASE_UNITS,
  humanToBaseUnits,
  quoteBuyBaseUnits
} from '../contract-math';
import {
  assertValidOfferTitle,
  buildOp,
  createOfferingPayload,
  registerPayload,
  type CustomJsonOp
} from './op-builders';

export interface BuildLaunchOpsInput {
  netId: string;
  contractId: string;
  /** Per-op rc_limit override; when unset each op uses its own `rcLimitForAction`. Same source as the standalone writes (config.rcLimit). */
  rcLimit?: number;
  /** The register op (op 0). `creator` is the sole signer for the whole bundle. */
  register: RegisterMarketInput;
  /** The offering ops (ops 1..N), in the order they will be broadcast. */
  offerings: CreateOfferingInput[];
}

/**
 * Build the register op (op 0) exactly as `registerMarket` does — same range
 * checks, same first-buy quote, same `hbdLegBaseUnits` intent. Returned with the
 * derived figures a caller may want (the first-buy cost that entered the reserve,
 * the face in base units) so nothing has to recompute them.
 *
 * KEEP IN SYNC with `VscCreatorTokensDataSource.registerMarket`: both build the
 * register op from `registerPayload` + `quoteBuyBaseUnits(0, firstBuyTokens)` and
 * the same contract constants imported here, so they cannot drift on the wire.
 */
export function buildLaunchRegisterOp(input: {
  netId: string;
  contractId: string;
  rcLimit?: number;
  register: RegisterMarketInput;
}): { op: CustomJsonOp; faceBaseUnits: number; firstBuyTokens: number; firstBuyCostBaseUnits: number; firstBuyTotalDueBaseUnits: number } {
  const { register } = input;
  const creator = typeof register.creator === 'string' ? register.creator.trim() : '';
  if (creator === '') {
    throw new Error('launch-ops: register carries no creator. Every launch op is signed by the creator (required_auths).');
  }

  const faceBaseUnits = humanToBaseUnits(register.faceHbd);
  // market.go registerCheck (core.Register) — same fixed-constant bounds as registerMarket.
  if (faceBaseUnits < MIN_FACE_BASE_UNITS || faceBaseUnits > MAX_FACE_BASE_UNITS) {
    throw new Error('launch-ops: face out of range [MinFace, MaxFace]');
  }
  // ★ 1000x TRAP: cap is ALREADY the raw integer token count — no humanToBaseUnits.
  const capTokens = register.capTokens;
  if (!Number.isInteger(capTokens) || capTokens < MIN_CAP_CREDITS_BASE_UNITS || capTokens > MAX_CAP_CREDITS_BASE_UNITS) {
    throw new Error('launch-ops: cap out of range [MinCap, MaxCap]');
  }
  const firstBuyTokens = register.firstBuyTokens ?? 0;
  if (!Number.isFinite(firstBuyTokens) || !Number.isInteger(firstBuyTokens) || firstBuyTokens < 0) {
    throw new Error('launch-ops: firstBuyTokens must be a non-negative whole number');
  }
  if (firstBuyTokens > capTokens) {
    throw new Error('launch-ops: firstBuyTokens would exceed the market cap');
  }

  // launch.go RegisterWithFirstBuy: the optional first buy is an ordinary Buy at
  // supply 0, previewed with the same curve math the contract runs. The HBD leg
  // is exactly that buy's TotalDue (cost + fee) — the buyer's own transfer.allow
  // slippage bound — and it rides ONLY on register.
  const firstBuyQuote = firstBuyTokens > 0 ? quoteBuyBaseUnits(0, firstBuyTokens) : null;
  const totalDueBaseUnits = firstBuyQuote?.totalDueBaseUnits ?? 0;

  const op = buildOp({
    netId: input.netId,
    contractId: input.contractId,
    action: 'register',
    payload: registerPayload(faceBaseUnits, capTokens, firstBuyTokens),
    hbdLegBaseUnits: totalDueBaseUnits > 0 ? totalDueBaseUnits : undefined,
    activeAuth: creator,
    rcLimit: input.rcLimit
  });

  return {
    op,
    faceBaseUnits,
    firstBuyTokens,
    firstBuyCostBaseUnits: firstBuyQuote?.costBaseUnits ?? 0,
    firstBuyTotalDueBaseUnits: totalDueBaseUnits
  };
}

/**
 * Build one createOffering op (ops 1..N) exactly as `createOffering` does — the
 * shared `validOfferTitle` and a positive-price guard, then `createOfferingPayload`
 * + `buildOp`. Carries NO first-buy intent: the first buy lives only on register.
 */
export function buildLaunchOfferingOp(input: {
  netId: string;
  contractId: string;
  rcLimit?: number;
  offering: CreateOfferingInput;
}): CustomJsonOp {
  const { offering } = input;
  const creator = typeof offering.creator === 'string' ? offering.creator.trim() : '';
  if (creator === '') {
    throw new Error('launch-ops: an offering carries no creator. Every launch op is signed by the creator (required_auths).');
  }
  // Same contract rule, same reason as createOffering: a title the chain would
  // refuse must be caught before signing, or it reverts the whole atomic launch.
  assertValidOfferTitle(offering.title);
  if (!(offering.priceHbd > 0)) {
    throw new Error('launch-ops: offering price must be > 0');
  }
  return buildOp({
    netId: input.netId,
    contractId: input.contractId,
    action: 'createOffering',
    payload: createOfferingPayload(offering.title, humanToBaseUnits(offering.priceHbd)),
    activeAuth: creator,
    rcLimit: input.rcLimit
  });
}

/**
 * The full launch op list: `[register, ...offerings]`, in order. Every op is
 * validated and built here; nothing is broadcast if any op cannot be built, so a
 * doomed op never reaches the atomic transaction.
 *
 * ★ ONE SIGNER. Every op must name the same creator — a Hive transaction carries
 * one signature, so a mixed-signer bundle could never verify. Enforced here
 * (fail-fast, local) and again in the bundle broadcaster (which also checks the
 * session's own signer).
 */
export function buildLaunchOps(input: BuildLaunchOpsInput): CustomJsonOp[] {
  const registerCreator = typeof input.register.creator === 'string' ? input.register.creator.trim() : '';
  const { op: registerOp } = buildLaunchRegisterOp({
    netId: input.netId,
    contractId: input.contractId,
    rcLimit: input.rcLimit,
    register: input.register
  });

  const offeringOps = input.offerings.map((offering, i) => {
    const offeringCreator = typeof offering.creator === 'string' ? offering.creator.trim() : '';
    if (offeringCreator !== registerCreator) {
      throw new Error(
        `launch-ops: offering ${i + 1} names a different creator (${offeringCreator || '(blank)'}) than register (${registerCreator}); a launch is one signature and cannot mix signers.`
      );
    }
    try {
      return buildLaunchOfferingOp({
        netId: input.netId,
        contractId: input.contractId,
        rcLimit: input.rcLimit,
        offering
      });
    } catch (e) {
      // Name the offering so the caller can point the creator at the exact row.
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`launch-ops: offering ${i + 1} cannot be launched: ${reason}`);
    }
  });

  return [registerOp, ...offeringOps];
}
