import { describe, expect, it } from 'vitest'
import { BASE_FEE_PER_SIGNATURE, VOTE_PROGRAM_ID } from './cost.ts'
import {
  MIN_SLOT_REF_SAMPLES,
  computeSlotRef,
  isSlotRefSample,
  percentile,
} from './reference.ts'
import type { BlockTransaction } from './rpc.ts'

const TIP_ACCOUNT = 'TipAccount1'
const TIP_ACCOUNTS = new Set([TIP_ACCOUNT])

type Overrides = {
  fee?: number
  tip?: number
  vote?: boolean
  failed?: boolean
}

function tx(o: Overrides = {}): BlockTransaction {
  const tip = o.tip ?? 0
  const accountKeys = ['payer', ...(o.vote ? [VOTE_PROGRAM_ID] : []), TIP_ACCOUNT]

  const preBalances = accountKeys.map(() => 1_000_000)
  const postBalances = accountKeys.map((key) => (key === TIP_ACCOUNT ? 1_000_000 + tip : 1_000_000))

  return {
    transaction: { signatures: ['sig'], message: { accountKeys, instructions: [] } },
    meta: {
      err: o.failed ? { InstructionError: [0, 'Custom'] } : null,
      fee: o.fee ?? BASE_FEE_PER_SIGNATURE,
      computeUnitsConsumed: 1000,
      preBalances,
      postBalances,
    },
  }
}

/** Слот, наповнений однаковими дешевими посадками, — фон для вимірювань нижче. */
function filler(count: number, fee: number): BlockTransaction[] {
  return Array.from({ length: count }, () => tx({ fee }))
}

describe('percentile', () => {
  it('returns a value that is actually present in the sample', () => {
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 1000)

    expect(percentile(values, 10)).toBe(10_000)
    expect(percentile(values, 50)).toBe(50_000)
    expect(percentile(values, 90)).toBe(90_000)
  })

  // Інтерполяція дала б 15 000 — суму, якої ніхто не платив і якої немає
  // в оглядачі блоків. Найближчий ранг завжди називає реальну посадку.
  it('never interpolates between neighbours', () => {
    expect(percentile([10_000, 20_000], 50)).toBe(10_000)
    expect(percentile([10_000, 20_000, 30_000], 50)).toBe(20_000)
  })

  it('sorts numerically, not lexicographically', () => {
    expect(percentile([9, 10, 100, 20], 50)).toBe(10)
  })

  it('does not mutate the caller sample', () => {
    const values = [30, 10, 20]
    percentile(values, 50)

    expect(values).toEqual([30, 10, 20])
  })

  it('yields the minimum at p0 and the maximum at p100', () => {
    const values = [5, 1, 9]

    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 100)).toBe(9)
  })

  it('handles a single observation', () => {
    expect(percentile([7], 10)).toBe(7)
  })

  it('rejects an empty sample instead of reporting zero', () => {
    expect(() => percentile([], 10)).toThrow(RangeError)
  })

  it('rejects a percentile outside 0…100', () => {
    expect(() => percentile([1, 2], -1)).toThrow(RangeError)
    expect(() => percentile([1, 2], 101)).toThrow(RangeError)
    expect(() => percentile([1, 2], Number.NaN)).toThrow(RangeError)
  })
})

describe('isSlotRefSample', () => {
  it('accepts a successful non-voting transaction', () => {
    expect(isSlotRefSample(tx())).toBe(true)
  })

  it('rejects voting transactions', () => {
    expect(isSlotRefSample(tx({ vote: true }))).toBe(false)
  })

  it('rejects failed transactions', () => {
    expect(isSlotRefSample(tx({ failed: true }))).toBe(false)
  })
})

describe('computeSlotRef', () => {
  it('takes the tenth percentile of the full landing cost', () => {
    // 90 посадок по 100 000 і 10 по 6 000: p10 — найдорожча з дешевих.
    const transactions = [...filler(10, 6_000), ...filler(90, 100_000)]

    const ref = computeSlotRef(1, transactions, TIP_ACCOUNTS)

    expect(ref).toEqual({ slot: 1, refLamports: 6_000, sampleCount: 100 })
  })

  it('counts tips as part of the landing cost', () => {
    const transactions = Array.from({ length: 100 }, () => tx({ fee: 5_000, tip: 1_000 }))

    const ref = computeSlotRef(2, transactions, TIP_ACCOUNTS)

    expect(ref?.refLamports).toBe(6_000)
  })

  // FR-031: вотингові платять лише базову комісію і становлять більшість блока.
  // Без їх виключення еталон впав би до 5 000, і надлишком стала б уся доставка.
  it('ignores voting transactions when computing the reference', () => {
    const transactions = [
      ...Array.from({ length: 400 }, () => tx({ vote: true, fee: BASE_FEE_PER_SIGNATURE })),
      ...filler(60, 80_000),
    ]

    const ref = computeSlotRef(3, transactions, TIP_ACCOUNTS)

    expect(ref).toEqual({ slot: 3, refLamports: 80_000, sampleCount: 60 })
  })

  it('ignores failed transactions', () => {
    const transactions = [
      ...Array.from({ length: 60 }, () => tx({ failed: true, fee: 1_000 })),
      ...filler(60, 80_000),
    ]

    const ref = computeSlotRef(4, transactions, TIP_ACCOUNTS)

    expect(ref?.sampleCount).toBe(60)
    expect(ref?.refLamports).toBe(80_000)
  })

  // FR-032: слот без достатньої вибірки лишається без еталона, а не з поганим.
  it('returns no reference below the minimum sample size', () => {
    const transactions = filler(MIN_SLOT_REF_SAMPLES - 1, 50_000)

    expect(computeSlotRef(5, transactions, TIP_ACCOUNTS)).toBeNull()
  })

  it('accepts a slot exactly at the minimum sample size', () => {
    const transactions = filler(MIN_SLOT_REF_SAMPLES, 50_000)

    expect(computeSlotRef(6, transactions, TIP_ACCOUNTS)?.sampleCount).toBe(
      MIN_SLOT_REF_SAMPLES,
    )
  })

  it('honours an overridden minimum', () => {
    const transactions = filler(3, 50_000)

    expect(computeSlotRef(7, transactions, TIP_ACCOUNTS, { minSamples: 3 })).toEqual({
      slot: 7,
      refLamports: 50_000,
      sampleCount: 3,
    })
  })

  it('returns no reference for an empty slot', () => {
    expect(computeSlotRef(8, [], TIP_ACCOUNTS)).toBeNull()
  })
})
