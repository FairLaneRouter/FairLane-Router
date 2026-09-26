import { describe, expect, it } from 'vitest'
import type { ChannelGroup } from './channels.ts'
import { BASE_FEE_PER_SIGNATURE } from './cost.ts'
import { type Intent, recommendationSchema } from './recommend.schema.ts'
import {
  chooseGroup,
  type GroupBidStats,
  type PricedGroup,
  priceGroups,
  priorityFeeLamports,
  recommend,
} from './recommend.ts'
import { MIN_GROUP_OBSERVATIONS } from './summary.ts'

const BASE = BigInt(BASE_FEE_PER_SIGNATURE)

const NOW = new Date('2026-09-26T12:00:00.000Z')
const STALE_AFTER_MS = 60_000

const ago = (ms: number) => new Date(NOW.getTime() - ms)

function group(id: string, patch: Partial<ChannelGroup> = {}): ChannelGroup {
  return {
    id,
    name: id,
    memberNames: [id],
    tipAccounts: [],
    isObserved: true,
    canSend: true,
    ...patch,
  }
}

function stats(
  groupId: string,
  tip: [bigint, bigint],
  price: [bigint, bigint],
  observations = MIN_GROUP_OBSERVATIONS,
  lastBlockTime = NOW,
): GroupBidStats {
  return {
    groupId,
    observations,
    tipLamports: { p50: tip[0], p90: tip[1] },
    priorityPriceMicroLamports: { p50: price[0], p90: price[1] },
    lastBlockTime,
  }
}

function intent(patch: Partial<Intent> = {}): Intent {
  return {
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    computeUnits: 200_000,
    mode: 'cheap',
    targetSlots: 4,
    ...patch,
  }
}

const ids = (ranked: readonly PricedGroup[]) => ranked.map((priced) => priced.groupId)

/**
 * RPC pays by the compute unit and tips nothing; Jito tips a flat amount and
 * pays almost nothing per unit. Which one is cheaper depends on the size of
 * the transaction — the reason the two components are never summed ahead.
 */
const rpc = stats('rpc', [0n, 0n], [10_000n, 50_000n])
const jito = stats('jito', [1_000n, 20_000n], [0n, 0n])
const registry = [group('rpc'), group('jito')]

describe('priorityFeeLamports', () => {
  it('multiplies price by units and converts micro-lamports to lamports', () => {
    expect(priorityFeeLamports(12_500n, 200_000)).toBe(2_500n)
  })

  it('rounds a fraction of a lamport up, as the runtime charges it', () => {
    expect(priorityFeeLamports(1n, 1)).toBe(1n)
    expect(priorityFeeLamports(1_000_001n, 1)).toBe(2n)
  })

  it('charges nothing at a zero price', () => {
    expect(priorityFeeLamports(0n, 1_400_000)).toBe(0n)
  })
})

describe('priceGroups', () => {
  it('adds the base fee, the priority fee for these units and the tip', () => {
    const [priced] = priceGroups({ intent: intent(), groups: registry, stats: [rpc] })

    expect(priced).toEqual({
      groupId: 'rpc',
      isSendable: true,
      observations: MIN_GROUP_OBSERVATIONS,
      tipLamports: 0n,
      priorityFeeMicroLamports: 10_000n,
      expectedCost: BASE + 2_000n,
      lastBlockTime: NOW,
    })
  })

  it('ranks by the cost of this intent, so a small transaction goes through RPC', () => {
    const ranked = priceGroups({
      intent: intent({ computeUnits: 50_000 }),
      groups: registry,
      stats: [jito, rpc],
    })

    // rpc: 10 000 µL × 50 000 CU = 500; jito: 1 000 tip.
    expect(ids(ranked)).toEqual(['rpc', 'jito'])
  })

  it('and a large one through Jito', () => {
    const ranked = priceGroups({
      intent: intent({ computeUnits: 1_000_000 }),
      groups: registry,
      stats: [rpc, jito],
    })

    // rpc: 10 000 µL × 1 000 000 CU = 10 000; jito: 1 000 tip.
    expect(ids(ranked)).toEqual(['jito', 'rpc'])
  })

  it('bids at p90 in fast mode, which can reverse the order', () => {
    const cheap = priceGroups({ intent: intent(), groups: registry, stats: [rpc, jito] })
    const fast = priceGroups({
      intent: intent({ mode: 'fast' }),
      groups: registry,
      stats: [rpc, jito],
    })

    // cheap: rpc 2 000 vs jito 1 000; fast: rpc 10 000 vs jito 20 000.
    expect(ids(cheap)).toEqual(['jito', 'rpc'])
    expect(ids(fast)).toEqual(['rpc', 'jito'])
    expect(fast[0]?.priorityFeeMicroLamports).toBe(50_000n)
  })

  it('drops a group below the evidence threshold and keeps one exactly at it', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: registry,
      stats: [
        stats('jito', [1n, 1n], [0n, 0n], MIN_GROUP_OBSERVATIONS - 1),
        stats('rpc', [0n, 0n], [10_000n, 10_000n], MIN_GROUP_OBSERVATIONS),
      ],
    })

    expect(ids(ranked)).toEqual(['rpc'])
  })

  it('honours a custom threshold', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: registry,
      stats: [stats('jito', [1n, 1n], [0n, 0n], 5)],
      minObservations: 5,
    })

    expect(ids(ranked)).toEqual(['jito'])
  })

  it('drops groups the registry does not know or does not observe', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: [group('rpc'), group('jito', { isObserved: false })],
      stats: [rpc, jito, stats('gone', [0n, 0n], [0n, 0n])],
    })

    expect(ids(ranked)).toEqual(['rpc'])
  })

  it('keeps an observed-only group in the ranking, marked as such', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: [group('rpc'), group('jito', { canSend: false })],
      stats: [rpc, jito],
    })

    expect(ranked.map((priced) => [priced.groupId, priced.isSendable])).toEqual([
      ['jito', false],
      ['rpc', true],
    ])
  })

  it('breaks a tie by evidence, then by id, so the same data gives the same advice', () => {
    const same = (groupId: string, observations: number) =>
      stats(groupId, [1_000n, 1_000n], [0n, 0n], observations)

    const ranked = priceGroups({
      intent: intent(),
      groups: [group('a'), group('b'), group('c')],
      stats: [same('c', 60), same('b', 90), same('a', 60)],
    })

    expect(ids(ranked)).toEqual(['b', 'a', 'c'])
  })

  it('prices nothing when there is nothing', () => {
    expect(priceGroups({ intent: intent(), groups: registry, stats: [] })).toEqual([])
  })
})

describe('chooseGroup', () => {
  it('takes the cheapest group', () => {
    const ranked = priceGroups({ intent: intent(), groups: registry, stats: [rpc, jito] })

    expect(chooseGroup(ranked)?.groupId).toBe('jito')
  })

  it('never recommends an observed-only group, however cheap', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: [group('rpc'), group('jito', { canSend: false })],
      stats: [rpc, jito],
    })

    expect(ranked[0]?.groupId).toBe('jito')
    expect(chooseGroup(ranked)?.groupId).toBe('rpc')
  })

  it('returns null when nothing sendable has enough evidence', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: [group('rpc', { canSend: false }), group('jito')],
      stats: [rpc, stats('jito', [1n, 1n], [0n, 0n], 1)],
    })

    expect(chooseGroup(ranked)).toBeNull()
    expect(chooseGroup([])).toBeNull()
  })
})

describe('recommend', () => {
  const advise = (groupStats: readonly GroupBidStats[], patch: Partial<Intent> = {}) =>
    recommend({
      intent: intent(patch),
      ranked: priceGroups({ intent: intent(patch), groups: registry, stats: groupStats }),
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    })

  it('answers with the chosen group, its numbers and the age of its data', () => {
    const advice = advise([rpc, stats('jito', [1_000n, 20_000n], [0n, 0n], 60, ago(4_200))])

    expect(advice).toEqual({
      groupId: 'jito',
      targetSlots: 4,
      tipLamports: 1_000,
      priorityFeeMicroLamports: 0,
      expectedCost: BASE_FEE_PER_SIGNATURE + 1_000,
      landProbability: null,
      dataAgeMs: 4_200,
      isStale: false,
      note: null,
    })
  })

  it('produces what the response schema accepts', () => {
    expect(recommendationSchema.safeParse(advise([rpc, jito])).success).toBe(true)
  })

  it('echoes the window the caller asked about', () => {
    expect(advise([rpc], { targetSlots: 2 })?.targetSlots).toBe(2)
  })

  it('passes over a cheaper group whose data has gone stale', () => {
    const staleJito = stats('jito', [1_000n, 20_000n], [0n, 0n], 60, ago(STALE_AFTER_MS + 1))

    expect(advise([rpc, staleJito])).toMatchObject({ groupId: 'rpc', isStale: false })
  })

  it('treats data exactly at the threshold as fresh', () => {
    const edge = stats('rpc', [0n, 0n], [10_000n, 10_000n], 60, ago(STALE_AFTER_MS))

    expect(advise([edge])).toMatchObject({ dataAgeMs: STALE_AFTER_MS, isStale: false })
  })

  it('falls back to the cheapest stale group, marked stale, when nothing is fresh', () => {
    const oldRpc = stats('rpc', [0n, 0n], [10_000n, 10_000n], 60, ago(3_600_000))
    const olderJito = stats('jito', [1_000n, 1_000n], [0n, 0n], 60, ago(7_200_000))

    expect(advise([oldRpc, olderJito])).toMatchObject({
      groupId: 'jito',
      dataAgeMs: 7_200_000,
      isStale: true,
    })
  })

  it('does not let a fresh observed-only group vouch for a stale sendable one', () => {
    const ranked = priceGroups({
      intent: intent(),
      groups: [group('rpc'), group('jito', { canSend: false })],
      stats: [stats('rpc', [0n, 0n], [10_000n, 10_000n], 60, ago(3_600_000)), jito],
    })

    expect(
      recommend({ intent: intent(), ranked, now: NOW, staleAfterMs: STALE_AFTER_MS }),
    ).toMatchObject({ groupId: 'rpc', isStale: true })
  })

  it('counts a block time ahead of our clock as brand new, not negative', () => {
    expect(advise([stats('rpc', [0n, 0n], [1n, 1n], 60, ago(-5_000))])?.dataAgeMs).toBe(0)
  })

  it('returns null rather than a made-up price when nothing sendable has evidence', () => {
    expect(advise([])).toBeNull()
    expect(advise([stats('rpc', [0n, 0n], [1n, 1n], 1)])).toBeNull()
  })
})
