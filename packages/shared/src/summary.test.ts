import { describe, expect, it } from 'vitest'
import { buildChannelRegistry, type ChannelGroup } from './channels.ts'
import {
  buildSummary,
  DEFAULT_SUMMARY_WINDOW,
  LamportsRangeError,
  MIN_GROUP_OBSERVATIONS,
  staleAfterMs,
  SUMMARY_WINDOW_MS,
  summarySchema,
  summaryWindowSchema,
  type GroupAggregate,
  type SummaryWindowFacts,
} from './summary.ts'

const NOW = new Date('2026-08-28T17:30:00.000Z')
const STALE_AFTER = staleAfterMs(100)

const registry = buildChannelRegistry({
  groups: [
    { id: 'jito', name: 'Jito' },
    { id: 'nozomi', name: 'Nozomi' },
    { id: 'rpc', name: 'Звичайний RPC' },
  ],
  channels: [
    {
      id: 'jito',
      groupId: 'jito',
      name: 'Jito',
      tipAccounts: ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'],
      isSendable: true,
      endpointEnvKey: 'CHANNEL_JITO_ENDPOINT',
    },
    {
      id: 'helius',
      groupId: 'jito',
      name: 'Helius Sender',
      tipAccounts: ['HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'],
    },
    {
      id: 'nozomi',
      groupId: 'nozomi',
      name: 'Nozomi',
      tipAccounts: ['noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4'],
      isSendable: true,
      endpointEnvKey: 'CHANNEL_NOZOMI_ENDPOINT',
    },
    { id: 'rpc', groupId: 'rpc', name: 'Звичайний RPC' },
  ],
  // Ендпоінт лише в Jito: Nozomi лишається каналом спостереження (FR-041).
}, { jito: 'https://jito.example' })

const groups: readonly ChannelGroup[] = registry.groups

function aggregate(overrides: Partial<GroupAggregate> = {}): GroupAggregate {
  return {
    groupId: 'jito',
    observations: 100,
    landings: 100,
    overpayObservations: 100,
    costP10: 10_000n,
    costP50: 20_000n,
    costP90: 90_000n,
    overpayP50: 8_000n,
    ...overrides,
  }
}

const facts: SummaryWindowFacts = {
  slotsSampled: 22,
  firstBlockTime: new Date('2026-08-28T17:03:00.000Z'),
  lastBlockTime: new Date('2026-08-28T17:29:30.000Z'),
}

function build(aggregates: readonly GroupAggregate[], overrides: Partial<SummaryWindowFacts> = {}) {
  return buildSummary({
    window: '1h',
    groups,
    aggregates,
    facts: { ...facts, ...overrides },
    now: NOW,
    staleAfterMs: STALE_AFTER,
  })
}

function groupOf(summary: ReturnType<typeof build>, id: string) {
  const found = summary.groups.find((group) => group.groupId === id)
  if (found === undefined) throw new Error(`групи ${id} немає у зведенні`)
  return found
}

describe('summaryWindowSchema', () => {
  it('accepts the three published windows and nothing else', () => {
    expect(summaryWindowSchema.parse('15m')).toBe('15m')
    expect(summaryWindowSchema.parse('24h')).toBe('24h')
    expect(summaryWindowSchema.safeParse('7d').success).toBe(false)
  })

  it('has a duration for every window it accepts', () => {
    for (const window of summaryWindowSchema.options) {
      expect(SUMMARY_WINDOW_MS[window]).toBeGreaterThan(0)
    }
    expect(SUMMARY_WINDOW_MS[DEFAULT_SUMMARY_WINDOW]).toBe(3_600_000)
  })
})

describe('staleAfterMs', () => {
  it('follows the sampling step: three intervals, two missed slots in a row', () => {
    expect(staleAfterMs(1000)).toBe(1_200_000)
  })

  // За малого кроку три інтервали стають секундами, і зведення блимало б
  // «застаріло» від звичайного відставання читача від голови ланцюга.
  it('never drops below a minute, however dense the sampling', () => {
    expect(staleAfterMs(1)).toBe(60_000)
    expect(staleAfterMs(100)).toBe(120_000)
  })

  it('rejects a step that is not a whole number of slots', () => {
    expect(() => staleAfterMs(0)).toThrow(RangeError)
    expect(() => staleAfterMs(1.5)).toThrow(RangeError)
  })
})

describe('buildSummary', () => {
  it('produces a payload its own schema accepts', () => {
    const summary = build([aggregate(), aggregate({ groupId: 'rpc', landings: 2000 })])

    expect(summarySchema.safeParse(summary).success).toBe(true)
  })

  it('reports the data each figure stands on: slots, rows, period, age', () => {
    const summary = build([
      aggregate({ observations: 120, landings: 120 }),
      aggregate({ groupId: 'rpc', observations: 60, landings: 1200 }),
    ])

    expect(summary.slotsSampled).toBe(22)
    expect(summary.observations).toBe(180)
    expect(summary.landings).toBe(1320)
    expect(summary.from).toBe('2026-08-28T16:30:00.000Z')
    expect(summary.to).toBe(NOW.toISOString())
    expect(summary.dataAgeMs).toBe(30_000)
    expect(summary.isStale).toBe(false)
    expect(summary.minObservations).toBe(MIN_GROUP_OBSERVATIONS)
  })

  // Кількість спостережень — міра доказовості, зважена кількість — оцінка
  // обсягу. Порівнювати з порогом можна лише першу (FR-012).
  it('measures sufficiency by raw rows, not by the sampling-weighted estimate', () => {
    const summary = build([
      aggregate({ groupId: 'rpc', observations: MIN_GROUP_OBSERVATIONS - 1, landings: 4000 }),
    ])
    const rpc = groupOf(summary, 'rpc')

    expect(rpc.sufficientData).toBe(false)
    expect(rpc.observations).toBe(MIN_GROUP_OBSERVATIONS - 1)
    expect(rpc.landings).toBeNull()
  })

  it('returns null, never zero, for a group below the threshold', () => {
    const summary = build([aggregate({ groupId: 'nozomi', observations: 7, landings: 7 })])
    const nozomi = groupOf(summary, 'nozomi')

    expect(nozomi).toMatchObject({
      sufficientData: false,
      landings: null,
      costP10: null,
      costP50: null,
      costP90: null,
      overpayP50: null,
      share: null,
    })
  })

  it('keeps a group with no landings at all in the answer', () => {
    const summary = build([aggregate()])

    expect(summary.groups.map((group) => group.groupId).sort()).toEqual(['jito', 'nozomi', 'rpc'])
    expect(groupOf(summary, 'nozomi').observations).toBe(0)
  })

  it('names the members of a group, because on-chain they are indistinguishable', () => {
    const summary = build([aggregate()])

    expect(groupOf(summary, 'jito').members).toEqual(['Jito', 'Helius Sender'])
  })

  // FR-041: канал може бути видимим у зведенні й недоступним для відправки.
  it('separates being observed from being sendable', () => {
    const summary = build([aggregate(), aggregate({ groupId: 'nozomi' })])

    expect(groupOf(summary, 'jito').isSendable).toBe(true)
    expect(groupOf(summary, 'nozomi').isSendable).toBe(false)
  })

  it('divides shares by the whole window, unattributed included', () => {
    const summary = build([
      aggregate({ landings: 300, observations: 300 }),
      aggregate({ groupId: null, landings: 100, observations: 100 }),
    ])

    expect(groupOf(summary, 'jito').share).toBeCloseTo(0.75)
    expect(summary.unattributed.share).toBeCloseTo(0.25)
    expect(summary.unattributed.landings).toBe(100)
  })

  // Частки видимих груп у сумі дають менше одиниці рівно на те, чого ми не
  // знаємо або не наважуємось стверджувати. Нормувати їх по видимих групах
  // означало б роздати невідоме тим, хто випадково потрапив у вибірку.
  it('leaves the missing share visible instead of normalising it away', () => {
    const summary = build([
      aggregate({ landings: 300, observations: 300 }),
      aggregate({ groupId: 'nozomi', landings: 100, observations: 5 }),
    ])
    const visible = summary.groups.reduce((sum, group) => sum + (group.share ?? 0), 0)

    expect(visible).toBeCloseTo(0.75)
    expect(summary.unattributed.share).toBe(0)
  })

  it('ranks by median cost and puts the groups without data after all of them', () => {
    const summary = build([
      aggregate({ costP50: 20_000n }),
      aggregate({ groupId: 'rpc', costP50: 6_000n }),
      aggregate({ groupId: 'nozomi', observations: 7, costP50: 1_000n }),
    ])

    expect(summary.groups.map((group) => group.groupId)).toEqual(['rpc', 'jito', 'nozomi'])
  })

  it('carries a negative overpay through: landing below the slot reference is not an error', () => {
    const summary = build([aggregate({ overpayP50: -1_200n })])

    expect(groupOf(summary, 'jito').overpayP50).toBe(-1200)
  })

  // Медіана надлишку стоїть на посадках зі слотів, що мали еталон, — їх може
  // бути менше, ніж посадок узагалі (FR-032, FR-015).
  it('counts separately how many observations back the overpay median', () => {
    const summary = build([aggregate({ observations: 100, overpayObservations: 60 })])

    expect(groupOf(summary, 'jito')).toMatchObject({
      observations: 100,
      overpayObservations: 60,
    })
  })

  it('calls the window stale when the newest landing is older than the threshold', () => {
    const summary = build([aggregate()], {
      lastBlockTime: new Date(NOW.getTime() - STALE_AFTER - 1),
    })

    expect(summary.isStale).toBe(true)
  })

  // Порожнє вікно свіжим оголошувати нема з чого.
  it('calls an empty window stale and leaves the age unknown', () => {
    const summary = build([], { slotsSampled: 0, firstBlockTime: null, lastBlockTime: null })

    expect(summary.dataAgeMs).toBeNull()
    expect(summary.isStale).toBe(true)
    expect(summary.landings).toBe(0)
    expect(summary.unattributed.share).toBe(0)
    expect(summary.groups.every((group) => !group.sufficientData)).toBe(true)
  })

  // Годинник вузла бази й годинник процесу — різні годинники.
  it('never reports a negative age when the block time runs ahead of the clock', () => {
    const summary = build([aggregate()], { lastBlockTime: new Date(NOW.getTime() + 5_000) })

    expect(summary.dataAgeMs).toBe(0)
  })

  it('keeps a vanished group out of the answer but inside the denominator', () => {
    const summary = build([
      aggregate({ landings: 300, observations: 300 }),
      aggregate({ groupId: 'bloxroute', landings: 100, observations: 100 }),
    ])

    expect(summary.groups.map((group) => group.groupId)).not.toContain('bloxroute')
    expect(summary.landings).toBe(400)
    expect(groupOf(summary, 'jito').share).toBeCloseTo(0.75)
  })

  it('refuses to round a sum that does not fit a safe JSON integer', () => {
    expect(() => build([aggregate({ costP50: BigInt(Number.MAX_SAFE_INTEGER) + 1n })])).toThrow(
      LamportsRangeError,
    )
  })
})
