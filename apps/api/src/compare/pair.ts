import { randomInt } from 'node:crypto'
import {
  BASE_FEE_PER_SIGNATURE,
  type ChannelRegistry,
  DEFAULT_TARGET_SLOTS,
  type Intent,
  priorityFeeLamports,
  RPC_GROUP_ID,
  type Recommendation,
  type RecommendMode,
} from '@fairlane/shared'
import { z } from 'zod'
import { compileLegMessage, MEMO_PROGRAM_ID } from './message.ts'

/**
 * The pair of twin intents behind a side-by-side run (FR-022, FR-042).
 *
 * Both legs are the same transaction — the same memo instruction under the
 * same compute unit limit — so the only thing that differs between them is
 * delivery: the channel and the bid. A swap would add an amount, rent and
 * slippage that are not delivery cost and would blur exactly the difference
 * the run is meant to show.
 *
 * - **Naive** is what an integrator who does not route does: plain RPC at a
 *   fixed compute unit price.
 * - **Routed** is whatever the recommendation for the same intent says — its
 *   group and its bid, unchanged. When the advice is plain RPC too, the pair
 *   still runs: the bid differs, and the router agreeing with the naive
 *   channel is a result, not a reason to send something else.
 *
 * Planning is pure; the clock, the blockhash and the signature come later.
 */

/** The naive leg's channel: the plain RPC an integrator sends through by default. */
export const NAIVE_GROUP_ID = RPC_GROUP_ID

/**
 * The naive leg's compute unit price, frozen: p75 of what plain-RPC landings
 * paid per compute unit over the 48 hours storage holds (79 106 landings,
 * 2026-10-20 07:37 – 2026-10-22 08:15 UTC). A fixed bid is what makes the leg
 * naive; taking it from measured landings, not from a round number, is what
 * keeps it from being a straw man. Storage divides by units consumed, not by
 * the limit, so the figure leans high — the same way the advice's does.
 */
export const NAIVE_PRIORITY_PRICE_MICRO_LAMPORTS = 1_012_195n

/**
 * One compute unit limit for both legs. Measured by simulation on mainnet on
 * 2026-10-22: 20 008 units for the 51-byte memo, 20 158 with the tip
 * transfer, the same for every run id. The rest is headroom for runtime cost
 * changes — a leg that runs out of units fails and still pays its fee.
 */
export const TWIN_COMPUTE_UNIT_LIMIT = 24_000

/** Fewer than two sendable groups leave the advice nothing to choose between (FR-042). */
export const MIN_SENDABLE_GROUPS = 2

export type PairRole = 'naive' | 'routed'

/**
 * Memo labels of equal length: the memo program's cost grows with the memo,
 * so twins with labels of different lengths would not burn the same units.
 */
const MEMO_LABEL: Readonly<Record<PairRole, string>> = { naive: 'naive', routed: 'route' }

const runIdSchema = z.uuid()

/** The intent both legs carry — and the one the recommendation must be asked for. */
export function twinIntent(mode: RecommendMode, targetSlots = DEFAULT_TARGET_SLOTS): Intent {
  return { programId: MEMO_PROGRAM_ID, computeUnits: TWIN_COMPUTE_UNIT_LIMIT, mode, targetSlots }
}

export type PairLeg = {
  readonly role: PairRole
  readonly groupId: string
  /** The registry channel to send through: its endpoint is the send's target (T053). */
  readonly channelId: string
  readonly memo: string
  readonly computeUnitLimit: number
  readonly priorityPriceMicroLamports: bigint
  readonly tip: { readonly account: string; readonly lamports: bigint } | null
  /**
   * What the leg costs if it lands — exactly, not an estimate: the base fee
   * is fixed, the priority fee is charged on the limit, not on what is used,
   * and the tip is what we transfer.
   */
  readonly costLamports: bigint
}

export type PairPlan = {
  readonly runId: string
  readonly naive: PairLeg
  readonly routed: PairLeg
  /** Both legs together: what the run can spend at most. */
  readonly costLamports: bigint
  /** The advice the routed leg follows, kept for showing it next to the result. */
  readonly recommendation: Recommendation
}

export const PAIR_REFUSAL_CODES = [
  'TOO_FEW_SENDABLE_GROUPS',
  'GROUP_NOT_SENDABLE',
  'NO_RECOMMENDATION',
  'OVER_RUN_LIMIT',
] as const

export type PairRefusalCode = (typeof PAIR_REFUSAL_CODES)[number]

/** Why no pair is sent. Nothing is reserved or spent before a plan exists. */
export type PairRefusal = {
  readonly code: PairRefusalCode
  readonly message: string
}

export type PairResult =
  | { readonly ok: true; readonly plan: PairPlan }
  | { readonly ok: false; readonly refusal: PairRefusal }

export class PairError extends Error {
  override name = 'PairError'
}

export type PlanPairOptions = {
  /** The comparison's id; it goes into both memos, so the twins never share a signature. */
  readonly runId: string
  readonly registry: ChannelRegistry
  /** Advice for `twinIntent(...)`; `null` when there was none to give. */
  readonly recommendation: Recommendation | null
  /** `budget.perRunLamports` — the pair has to fit under it (T051). */
  readonly perRunLamports: bigint
  /** Which of a group's tip accounts to pay; random by default, as Jito asks. */
  readonly pickIndex?: (length: number) => number
}

function refuse(code: PairRefusalCode, message: string): PairResult {
  return { ok: false, refusal: { code, message } }
}

function legCost(priceMicroLamports: bigint, tipLamports: bigint): bigint {
  return (
    BigInt(BASE_FEE_PER_SIGNATURE) +
    priorityFeeLamports(priceMicroLamports, TWIN_COMPUTE_UNIT_LIMIT) +
    tipLamports
  )
}

/**
 * Plans the pair, or says why there is none.
 *
 * The run limit is checked here, before anything is reserved, and a pair over
 * it is refused rather than trimmed: a smaller routed bid would no longer be
 * the advice, and a smaller naive bid would no longer be fixed.
 */
export function planPair(options: PlanPairOptions): PairResult {
  const { registry, recommendation, perRunLamports } = options
  const pickIndex = options.pickIndex ?? randomInt

  const runId = runIdSchema.safeParse(options.runId)
  if (!runId.success) throw new PairError('runId must be a UUID')

  const sendable = registry.sendableGroups
  if (sendable.length < MIN_SENDABLE_GROUPS) {
    return refuse(
      'TOO_FEW_SENDABLE_GROUPS',
      `a side-by-side run needs at least ${MIN_SENDABLE_GROUPS} groups to send through, ` +
        `there ${sendable.length === 1 ? 'is' : 'are'} ${sendable.length}`,
    )
  }

  const channelOf = (groupId: string) =>
    registry.channels.find((channel) => channel.groupId === groupId && channel.canSend)

  const naiveChannel = channelOf(NAIVE_GROUP_ID)
  if (naiveChannel === undefined) {
    return refuse('GROUP_NOT_SENDABLE', `the naive group ${NAIVE_GROUP_ID} cannot be sent through`)
  }

  if (recommendation === null) {
    return refuse('NO_RECOMMENDATION', 'no sendable group has enough recent landings to advise on')
  }

  const routedChannel = channelOf(recommendation.groupId)
  if (routedChannel === undefined) {
    return refuse(
      'GROUP_NOT_SENDABLE',
      `the recommended group ${recommendation.groupId} cannot be sent through`,
    )
  }

  const tipLamports = BigInt(recommendation.tipLamports)
  let tip: PairLeg['tip'] = null
  if (tipLamports > 0n) {
    const accounts = registry.groupById(recommendation.groupId)?.tipAccounts ?? []
    // Checked before picking: `randomInt(0)` throws a RangeError of its own.
    const account = accounts.length === 0 ? undefined : accounts[pickIndex(accounts.length)]
    if (account === undefined) {
      throw new PairError(`group ${recommendation.groupId} is advised a tip but has no tip account`)
    }
    tip = { account, lamports: tipLamports }
  }

  const routedPrice = BigInt(recommendation.priorityFeeMicroLamports)
  const naive: PairLeg = {
    role: 'naive',
    groupId: NAIVE_GROUP_ID,
    channelId: naiveChannel.id,
    memo: `fairlane:${runId.data}:${MEMO_LABEL.naive}`,
    computeUnitLimit: TWIN_COMPUTE_UNIT_LIMIT,
    priorityPriceMicroLamports: NAIVE_PRIORITY_PRICE_MICRO_LAMPORTS,
    tip: null,
    costLamports: legCost(NAIVE_PRIORITY_PRICE_MICRO_LAMPORTS, 0n),
  }
  const routed: PairLeg = {
    role: 'routed',
    groupId: recommendation.groupId,
    channelId: routedChannel.id,
    memo: `fairlane:${runId.data}:${MEMO_LABEL.routed}`,
    computeUnitLimit: TWIN_COMPUTE_UNIT_LIMIT,
    priorityPriceMicroLamports: routedPrice,
    tip,
    costLamports: legCost(routedPrice, tipLamports),
  }

  const costLamports = naive.costLamports + routed.costLamports
  if (costLamports > perRunLamports) {
    return refuse(
      'OVER_RUN_LIMIT',
      `the pair costs up to ${costLamports} lamports, over the per-run limit of ${perRunLamports}`,
    )
  }

  return { ok: true, plan: { runId: runId.data, naive, routed, costLamports, recommendation } }
}

/**
 * Both legs' messages, under one blockhash: they expire together, so neither
 * gets a longer window to land in than the other.
 */
export function pairMessages(
  plan: PairPlan,
  payer: string,
  recentBlockhash: string,
): Readonly<Record<PairRole, Uint8Array>> {
  const compile = (leg: PairLeg) =>
    compileLegMessage({
      payer,
      recentBlockhash,
      computeUnitLimit: leg.computeUnitLimit,
      priorityPriceMicroLamports: leg.priorityPriceMicroLamports,
      memo: leg.memo,
      tip: leg.tip,
    })

  return { naive: compile(plan.naive), routed: compile(plan.routed) }
}
