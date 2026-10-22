import {
  buildChannelRegistry,
  DEFAULT_REGISTRY,
  type GroupBidStats,
  priceGroups,
  type Recommendation,
  recommend,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { compileLegMessage, MEMO_PROGRAM_ID } from './message.ts'
import {
  NAIVE_PRIORITY_PRICE_MICRO_LAMPORTS,
  PairError,
  type PairPlan,
  type PairResult,
  pairMessages,
  planPair,
  TWIN_COMPUTE_UNIT_LIMIT,
  twinIntent,
} from './pair.ts'

const RUN_ID = '0b6f3f5e-3c1a-4c84-9d2e-8f1f2a3b4c5d'
const PER_RUN = 2_000_000n
const PAYER = '8f3pvbjMNurWLc3kCypQGo5VWNrCumF3KdhQrYm8Ptk5'
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

// What is live: Jito through the public Block Engine, plain RPC through the base node.
const live = buildChannelRegistry(DEFAULT_REGISTRY, { jito: 'https://jito.example' })

const advice = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  groupId: 'jito',
  targetSlots: 4,
  tipLamports: 1_000,
  priorityFeeMicroLamports: 0,
  expectedCost: 6_000,
  landProbability: null,
  dataAgeMs: 2_000,
  isStale: false,
  note: null,
  ...overrides,
})

function planned(result: PairResult): PairPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.code}`)
  return result.plan
}

function refusal(result: PairResult) {
  if (result.ok) throw new Error('planned, expected a refusal')
  return result.refusal
}

// 5 000 base + ⌈1 012 195 × 24 000 / 10⁶⌉ = 5 000 + 24 293.
const NAIVE_COST = 29_293n

describe('twinIntent', () => {
  it('is the memo transaction under the shared limit', () => {
    expect(twinIntent('cheap')).toEqual({
      programId: MEMO_PROGRAM_ID,
      computeUnits: TWIN_COMPUTE_UNIT_LIMIT,
      mode: 'cheap',
      targetSlots: 4,
    })
    expect(twinIntent('fast', 10).targetSlots).toBe(10)
  })
})

describe('planPair', () => {
  const base = { runId: RUN_ID, registry: live, perRunLamports: PER_RUN, pickIndex: () => 3 }

  it('sends the naive leg through plain RPC at the frozen price, without a tip', () => {
    const { naive } = planned(planPair({ ...base, recommendation: advice() }))

    expect(naive).toEqual({
      role: 'naive',
      groupId: 'rpc',
      channelId: 'rpc',
      memo: `fairlane:${RUN_ID}:naive`,
      computeUnitLimit: TWIN_COMPUTE_UNIT_LIMIT,
      priorityPriceMicroLamports: NAIVE_PRIORITY_PRICE_MICRO_LAMPORTS,
      tip: null,
      costLamports: NAIVE_COST,
    })
  })

  it('sends the routed leg exactly as advised, the tip to one of the group’s accounts', () => {
    const { routed, costLamports } = planned(planPair({ ...base, recommendation: advice() }))
    const jito = live.groupById('jito')

    expect(routed).toMatchObject({
      role: 'routed',
      groupId: 'jito',
      channelId: 'jito',
      memo: `fairlane:${RUN_ID}:route`,
      priorityPriceMicroLamports: 0n,
      tip: { account: jito?.tipAccounts[3], lamports: 1_000n },
      costLamports: 6_000n,
    })
    expect(costLamports).toBe(NAIVE_COST + 6_000n)
  })

  it('picks a tip account at random by default', () => {
    const jito = new Set(live.groupById('jito')?.tipAccounts)
    const accounts = new Set(
      Array.from({ length: 64 }, () => {
        const { routed } = planned(
          planPair({ runId: RUN_ID, registry: live, perRunLamports: PER_RUN, recommendation: advice() }),
        )
        return routed.tip?.account
      }),
    )

    for (const account of accounts) expect(jito.has(account ?? '')).toBe(true)
    expect(accounts.size).toBeGreaterThan(1)
  })

  it('gives the twins memos of equal length, so they burn the same units', () => {
    const { naive, routed } = planned(planPair({ ...base, recommendation: advice() }))

    expect(naive.memo).not.toBe(routed.memo)
    expect(new TextEncoder().encode(naive.memo).length).toBe(
      new TextEncoder().encode(routed.memo).length,
    )
  })

  it('prices the routed leg as the advice for the twin intent did', () => {
    const stats: GroupBidStats[] = ['jito', 'rpc'].map((groupId) => ({
      groupId,
      observations: 500,
      tipLamports: { p50: groupId === 'jito' ? 2_500n : 0n, p90: 9_000n },
      priorityPriceMicroLamports: { p50: 120_000n, p90: 5_000_000n },
      lastBlockTime: new Date('2026-10-22T08:00:00Z'),
    }))
    const intent = twinIntent('cheap')
    const recommendation = recommend({
      intent,
      ranked: priceGroups({ intent, groups: live.groups, stats }),
      now: new Date('2026-10-22T08:00:05Z'),
      staleAfterMs: 60_000,
    })
    if (recommendation === null) throw new Error('no advice')

    const { routed } = planned(planPair({ ...base, recommendation }))
    expect(routed.costLamports).toBe(BigInt(recommendation.expectedCost))
  })

  it('still runs when the advice is plain RPC too — the bid is what differs', () => {
    const { naive, routed } = planned(
      planPair({
        ...base,
        recommendation: advice({ groupId: 'rpc', tipLamports: 0, priorityFeeMicroLamports: 120_000 }),
      }),
    )

    expect(routed.groupId).toBe(naive.groupId)
    expect(routed.tip).toBeNull()
    expect(routed.priorityPriceMicroLamports).toBe(120_000n)
    // 5 000 + ⌈120 000 × 24 000 / 10⁶⌉
    expect(routed.costLamports).toBe(7_880n)
  })

  it('carries a stale advice through with its flag, for the run to show', () => {
    const stale = advice({ isStale: true, dataAgeMs: 3_600_000 })
    expect(planned(planPair({ ...base, recommendation: stale })).recommendation).toBe(stale)
  })

  it('fits the dearest sendable group under the default run limit', () => {
    const all = buildChannelRegistry(DEFAULT_REGISTRY, {
      jito: 'https://jito.example',
      nozomi: 'https://nozomi.example',
      bloxroute: 'https://bloxroute.example',
    })

    for (const groupId of ['nozomi', 'bloxroute']) {
      const plan = planned(
        planPair({
          ...base,
          registry: all,
          recommendation: advice({ groupId, tipLamports: 1_000_000, expectedCost: 1_005_000 }),
        }),
      )
      expect(plan.costLamports).toBe(NAIVE_COST + 1_005_000n)
      expect(plan.costLamports).toBeLessThanOrEqual(PER_RUN)
    }
  })

  it('takes a pair that costs exactly the run limit', () => {
    const limit = NAIVE_COST + 6_000n
    expect(planPair({ ...base, perRunLamports: limit, recommendation: advice() }).ok).toBe(true)
  })

  it('refuses a pair over the run limit instead of trimming a bid', () => {
    const limit = NAIVE_COST + 6_000n - 1n
    const result = refusal(planPair({ ...base, perRunLamports: limit, recommendation: advice() }))

    expect(result.code).toBe('OVER_RUN_LIMIT')
    expect(result.message).toContain(String(limit + 1n))
  })

  it('refuses with fewer than two groups to send through (FR-042)', () => {
    const rpcOnly = buildChannelRegistry(DEFAULT_REGISTRY, {})
    const result = refusal(planPair({ ...base, registry: rpcOnly, recommendation: advice() }))

    expect(result.code).toBe('TOO_FEW_SENDABLE_GROUPS')
    expect(result.message).toMatch(/there is 1$/)
  })

  it('counts groups, not channels: two channels of one group are one choice', () => {
    const doubled = buildChannelRegistry(
      {
        ...DEFAULT_REGISTRY,
        channels: [
          ...DEFAULT_REGISTRY.channels,
          { ...DEFAULT_REGISTRY.channels[3], id: 'rpc-second', name: 'Second RPC' },
        ],
      },
      {},
    )
    expect(refusal(planPair({ ...base, registry: doubled, recommendation: advice() })).code).toBe(
      'TOO_FEW_SENDABLE_GROUPS',
    )
  })

  it('refuses when plain RPC itself cannot be sent through', () => {
    const noRpc = buildChannelRegistry(
      {
        ...DEFAULT_REGISTRY,
        channels: DEFAULT_REGISTRY.channels.map((channel) =>
          channel.id === 'rpc' ? { ...channel, isSendable: false } : channel,
        ),
      },
      { jito: 'https://jito.example', nozomi: 'https://nozomi.example' },
    )
    const result = refusal(planPair({ ...base, registry: noRpc, recommendation: advice() }))

    expect(result.code).toBe('GROUP_NOT_SENDABLE')
    expect(result.message).toContain('rpc')
  })

  it('refuses without advice', () => {
    expect(refusal(planPair({ ...base, recommendation: null })).code).toBe('NO_RECOMMENDATION')
  })

  it('refuses advice for a group it cannot send through', () => {
    const result = refusal(
      planPair({ ...base, recommendation: advice({ groupId: 'nozomi', tipLamports: 1_000_000 }) }),
    )

    expect(result.code).toBe('GROUP_NOT_SENDABLE')
    expect(result.message).toContain('nozomi')
  })

  it('throws on a tip advised to a group with nowhere to pay it', () => {
    expect(() =>
      planPair({ ...base, recommendation: advice({ groupId: 'rpc', tipLamports: 5 }) }),
    ).toThrow(PairError)
  })

  it('throws on a run id that is not a UUID', () => {
    expect(() => planPair({ ...base, runId: 'run-1', recommendation: advice() })).toThrow(
      PairError,
    )
  })
})

describe('pairMessages', () => {
  it('compiles both legs under one blockhash, each as planned', () => {
    const plan = planned(
      planPair({
        runId: RUN_ID,
        registry: live,
        perRunLamports: PER_RUN,
        recommendation: advice(),
        pickIndex: () => 0,
      }),
    )
    const messages = pairMessages(plan, PAYER, BLOCKHASH)

    for (const leg of [plan.naive, plan.routed]) {
      expect(messages[leg.role]).toEqual(
        compileLegMessage({
          payer: PAYER,
          recentBlockhash: BLOCKHASH,
          computeUnitLimit: leg.computeUnitLimit,
          priorityPriceMicroLamports: leg.priorityPriceMicroLamports,
          memo: leg.memo,
          tip: leg.tip,
        }),
      )
    }
    expect(messages.naive).not.toEqual(messages.routed)
  })
})
