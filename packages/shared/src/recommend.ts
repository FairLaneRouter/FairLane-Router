import type { ChannelGroup } from './channels.ts'
import { BASE_FEE_PER_SIGNATURE } from './cost.ts'
import type { Intent, RecommendMode } from './recommend.schema.ts'
import { MIN_GROUP_OBSERVATIONS } from './summary.ts'

/**
 * Channel choice for a recommendation (FR-016), as pure functions over what
 * storage already knows.
 *
 * The spec defines "fast" as the group with the highest share of landings
 * within the target window. Passive collection cannot measure that: it sees
 * what landed, never when it was sent — that share comes from our own sends
 * (T058). Until then each mode is a **bid level** within a group (owner's
 * decision, 2026-09-26): "cheap" bids what the median recent lander paid,
 * "fast" outbids nine landers in ten. The landing probability stays `null`
 * rather than dressing that rank up as one.
 */

/** Which percentile of recent landings each mode bids at. */
export const MODE_PERCENTILE: Readonly<Record<RecommendMode, 'p50' | 'p90'>> = {
  cheap: 'p50',
  fast: 'p90',
}

/** Micro-lamports per lamport: the unit of the compute unit price. */
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n

/** A percentile pair, as the storage query returns it. */
export type PercentilePair = {
  readonly p50: bigint
  readonly p90: bigint
}

/**
 * What a group's recent landings say about bidding through it. The two
 * components are kept apart, not summed into one cost: a total mixes
 * transactions of every size, while the priority fee scales with the compute
 * units of **this** intent and the tip does not.
 */
export type GroupBidStats = {
  readonly groupId: string
  /** Raw rows behind the percentiles — the evidence threshold is on these (FR-012). */
  readonly observations: number
  readonly tipLamports: PercentilePair
  /**
   * Compute unit price in micro-lamports. Storage has the fee and the units
   * consumed, not the limit that was requested, and the runtime charges on the
   * limit; dividing by what was consumed overstates the price. That errs on
   * the side of landing, which is the right side for a bid.
   */
  readonly priorityPriceMicroLamports: PercentilePair
}

/** A group priced for one intent. Money stays `bigint` until the JSON boundary. */
export type PricedGroup = {
  readonly groupId: string
  readonly isSendable: boolean
  readonly observations: number
  readonly tipLamports: bigint
  readonly priorityFeeMicroLamports: bigint
  readonly expectedCost: bigint
}

/**
 * The priority fee the runtime charges: price times the compute unit limit,
 * rounded **up** to a whole lamport — as the runtime rounds it.
 */
export function priorityFeeLamports(priceMicroLamports: bigint, computeUnits: number): bigint {
  const microLamports = priceMicroLamports * BigInt(computeUnits)

  return (microLamports + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT
}

export type PriceGroupsOptions = {
  readonly intent: Intent
  /** The channel registry's groups — the source of `isSendable` (FR-040). */
  readonly groups: readonly ChannelGroup[]
  readonly stats: readonly GroupBidStats[]
  readonly minObservations?: number
}

/**
 * Every group with enough evidence, priced for this intent at the mode's bid
 * level and ranked cheapest first.
 *
 * Groups that cannot be sent through are **kept** in the ranking: choosing
 * skips them, but the note of FR-041 (T044) needs to know that a cheaper one
 * exists. Groups below the evidence threshold are dropped, as the summary
 * drops their numbers (FR-012) — advice priced from a handful of landings
 * would be the most expensive transaction of the sample, not a percentile.
 *
 * The base fee is one signature's: an intent carries no signature count, and
 * one signature is what a transaction with a single signer pays.
 */
export function priceGroups(options: PriceGroupsOptions): PricedGroup[] {
  const { intent, groups, stats } = options
  const minObservations = options.minObservations ?? MIN_GROUP_OBSERVATIONS
  const level = MODE_PERCENTILE[intent.mode]
  const registry = new Map(groups.map((group) => [group.id, group]))

  const priced: PricedGroup[] = []

  for (const stat of stats) {
    const group = registry.get(stat.groupId)
    if (group === undefined || !group.isObserved) continue
    if (stat.observations < minObservations) continue

    const tipLamports = stat.tipLamports[level]
    const priorityFeeMicroLamports = stat.priorityPriceMicroLamports[level]
    const expectedCost =
      BigInt(BASE_FEE_PER_SIGNATURE) +
      priorityFeeLamports(priorityFeeMicroLamports, intent.computeUnits) +
      tipLamports

    priced.push({
      groupId: stat.groupId,
      isSendable: group.canSend,
      observations: stat.observations,
      tipLamports,
      priorityFeeMicroLamports,
      expectedCost,
    })
  }

  return priced.sort(byCost)
}

/**
 * Cheapest first. On a tie the group with more evidence wins — the same price
 * backed by more landings is the safer promise — and the id settles the rest,
 * so the same data always gives the same advice.
 */
function byCost(left: PricedGroup, right: PricedGroup): number {
  if (left.expectedCost !== right.expectedCost)
    return left.expectedCost < right.expectedCost ? -1 : 1
  if (left.observations !== right.observations) return right.observations - left.observations

  return left.groupId < right.groupId ? -1 : 1
}

/**
 * The recommended group: the cheapest one we can actually send through. An
 * observed-only group is never recommended (FR-041). `null` when nothing
 * sendable has enough evidence — the stale fallback of T043 answers then.
 */
export function chooseGroup(ranked: readonly PricedGroup[]): PricedGroup | null {
  return ranked.find((group) => group.isSendable) ?? null
}
