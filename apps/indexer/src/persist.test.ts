import { createLogger, type SlotRef } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import type { ParsedLanding } from './parse.ts'
import { persistLandings, withOverpay, type LandingRow, type LandingStore } from './persist.ts'

const SLOT = 341_882_103

function landing(overrides: Partial<ParsedLanding> = {}): ParsedLanding {
  return {
    signature: 'sig',
    slot: SLOT,
    blockTime: new Date(1_800_000_000_000),
    baseFee: 5000n,
    priorityFee: 4700n,
    tipTotal: 0n,
    totalCost: 9700n,
    cuConsumed: 42_000,
    groupId: 'rpc',
    attributionBasis: 'priority-fee',
    feePayer: 'payer',
    programIds: ['SomeProgram'],
    isSampled: true,
    ...overrides,
  }
}

const ref: SlotRef = { slot: SLOT, refLamports: 8000, sampleCount: 435 }

function fakeStore(): LandingStore & { readonly saved: LandingRow[] } {
  const saved: LandingRow[] = []

  return {
    saved,
    save: (rows) => {
      saved.push(...rows)
      return Promise.resolve(rows.length)
    },
  }
}

const silent = createLogger({ level: 'fatal', sink: () => {} })

describe('withOverpay', () => {
  it('takes the overpay as cost minus the slot reference', () => {
    const [row] = withOverpay([landing({ totalCost: 209_700n })], ref)

    expect(row?.overpay).toBe(201_700n)
  })

  // Сторінка методики обіцяє це вголос: сісти дешевше за десятий процентиль
  // не помилка, а ті дев'ять відсотків, що під ним. Обрізання в нуль зробило б
  // середній надлишок систематично завищеним.
  it('keeps a negative overpay for a landing cheaper than the reference', () => {
    const [row] = withOverpay([landing({ totalCost: 5000n })], ref)

    expect(row?.overpay).toBe(-3000n)
  })

  it('leaves the overpay empty for a slot without a reference (FR-032)', () => {
    const rows = withOverpay([landing(), landing({ signature: 'other' })], null)

    expect(rows.map((row) => row.overpay)).toEqual([null, null])
    expect(rows).toHaveLength(2)
  })

  it('carries the parsed landing through untouched', () => {
    const [row] = withOverpay([landing({ tipTotal: 200_000n })], null)

    expect(row?.tipTotal).toBe(200_000n)
    expect(row?.programIds).toEqual(['SomeProgram'])
    expect(row?.feePayer).toBe('payer')
  })
})

describe('persistLandings', () => {
  it('stores every landing of the slot with its overpay', async () => {
    const store = fakeStore()

    const saved = await persistLandings(
      [landing({ signature: 'a', totalCost: 9700n }), landing({ signature: 'b', totalCost: 8000n })],
      ref,
      { store, logger: silent },
    )

    expect(saved).toBe(2)
    expect(store.saved.map((row) => row.overpay)).toEqual([1700n, 0n])
  })

  // FR-039: «неатрибутовано» — не окрема таблиця й не відкинутий рядок, а
  // порожній `group_id` у тій самій вибірці. Інакше його частки не було б з
  // чим порівнювати у зведенні.
  it('stores unattributed landings alongside the rest', async () => {
    const store = fakeStore()

    await persistLandings(
      [
        landing({ signature: 'tipped', groupId: 'jito', attributionBasis: 'tip' }),
        landing({ signature: 'both', groupId: null, attributionBasis: 'ambiguous' }),
        landing({ signature: 'free', groupId: null, attributionBasis: 'none' }),
      ],
      ref,
      { store, logger: silent },
    )

    expect(store.saved).toHaveLength(3)
    expect(store.saved.filter((row) => row.groupId === null).map((row) => row.attributionBasis)).toEqual([
      'ambiguous',
      'none',
    ])
  })

  it('does not touch the store when the slot kept nothing', async () => {
    const store = fakeStore()

    const saved = await persistLandings([], ref, { store, logger: silent })

    expect(saved).toBe(0)
    expect(store.saved).toEqual([])
  })

  // Слот без еталона все одно зберігає свої посадки (FR-032) — вони просто не
  // входять у показники надлишку.
  it('stores the landings of a slot that has no reference', async () => {
    const store = fakeStore()

    const saved = await persistLandings([landing()], null, { store, logger: silent })

    expect(saved).toBe(1)
    expect(store.saved[0]?.overpay).toBeNull()
  })

  it('lets a storage failure through to the caller', async () => {
    const failing: LandingStore = { save: () => Promise.reject(new Error('немає зʼєднання')) }

    await expect(
      persistLandings([landing()], ref, { store: failing, logger: silent }),
    ).rejects.toThrow('немає зʼєднання')
  })
})
