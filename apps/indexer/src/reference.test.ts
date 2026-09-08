import type { Block, BlockTransaction } from '@fairlane/shared'
import { createLogger, VOTE_PROGRAM_ID } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { recordSlotRef, type SlotRefRow, type SlotRefStore } from './reference.ts'

const TIP_ACCOUNT = 'TipAccount1'
const TIP_ACCOUNTS = new Set([TIP_ACCOUNT])
const SLOT = 341_882_103

type Overrides = {
  fee?: number
  tip?: number
  vote?: boolean
  failed?: boolean
}

function tx(o: Overrides = {}): BlockTransaction {
  const tip = o.tip ?? 0
  const accountKeys = ['payer', ...(o.vote === true ? [VOTE_PROGRAM_ID] : []), TIP_ACCOUNT]

  return {
    transaction: { signatures: ['sig'], message: { accountKeys, instructions: [] } },
    meta: {
      err: o.failed === true ? { InstructionError: [0, 'Custom'] } : null,
      fee: o.fee ?? 5000,
      computeUnitsConsumed: 1000,
      preBalances: accountKeys.map(() => 1_000_000),
      postBalances: accountKeys.map((key) => (key === TIP_ACCOUNT ? 1_000_000 + tip : 1_000_000)),
    },
  }
}

const block = (transactions: BlockTransaction[]): Block => ({
  blockhash: 'hash',
  parentSlot: SLOT - 1,
  blockTime: 1_800_000_000,
  transactions,
})

function fakeStore(): SlotRefStore & { readonly saved: SlotRefRow[] } {
  const saved: SlotRefRow[] = []

  return {
    saved,
    save: (row) => {
      saved.push(row)
      return Promise.resolve()
    },
  }
}

function collectingLogger() {
  const lines: string[] = []
  return { logger: createLogger({ level: 'trace', sink: (line) => lines.push(line) }), lines }
}

/** Рівний схил: 100 посадок від 5000 до 14900, десята найдешевша — 5900. */
const slope = Array.from({ length: 100 }, (_, index) => tx({ fee: 5000 + index * 100 }))

describe('recordSlotRef', () => {
  it('stores the tenth percentile of the full landing cost', async () => {
    const store = fakeStore()
    const { logger } = collectingLogger()

    const ref = await recordSlotRef(block(slope), SLOT, { store, tipAccounts: TIP_ACCOUNTS, logger })

    expect(ref).toEqual({ slot: SLOT, refLamports: 5900, sampleCount: 100 })
    expect(store.saved).toEqual([{ slot: SLOT, refLamports: 5900n, sampleCount: 100 }])
  })

  // Еталон вимірює повну вартість посадки, не саму комісію: слот, у якому всі
  // платять чайові, дорогий, і надлишок у ньому має рахуватись від цієї ціни.
  it('counts tips as part of the cost the reference is taken from', async () => {
    const store = fakeStore()
    const { logger } = collectingLogger()
    const tipped = Array.from({ length: 100 }, (_, index) =>
      tx({ fee: 5000, tip: 100_000 + index * 100 }),
    )

    await recordSlotRef(block(tipped), SLOT, { store, tipAccounts: TIP_ACCOUNTS, logger })

    expect(store.saved[0]?.refLamports).toBe(105_900n)
  })

  // FR-032: нуль у цій колонці означав би «сісти коштувало нічого», і
  // надлишком стала б уся ціна доставки. Тому рядка немає взагалі.
  it('writes nothing when the slot has too few samples', async () => {
    const store = fakeStore()
    const { logger, lines } = collectingLogger()

    const ref = await recordSlotRef(block(slope.slice(0, 49)), SLOT, {
      store,
      tipAccounts: TIP_ACCOUNTS,
      logger,
    })

    expect(ref).toBeNull()
    expect(store.saved).toEqual([])
    expect(lines.join('\n')).toContain('слот лишається без еталона')
  })

  // Вотингових у блоці більшість, і платять вони лише базову комісію. Якби
  // вони входили у вибірку, еталон обвалився б, а поріг FR-032 не спрацював би
  // саме там, де він потрібен.
  it('ignores voting and failed transactions in the sample', async () => {
    const store = fakeStore()
    const { logger } = collectingLogger()
    const noisy = [
      ...Array.from({ length: 200 }, () => tx({ vote: true })),
      ...Array.from({ length: 200 }, () => tx({ failed: true })),
      ...slope.slice(0, 10),
    ]

    const ref = await recordSlotRef(block(noisy), SLOT, {
      store,
      tipAccounts: TIP_ACCOUNTS,
      logger,
    })

    expect(ref).toBeNull()
    expect(store.saved).toEqual([])
  })

  it('honours a threshold lowered for the caller', async () => {
    const store = fakeStore()
    const { logger } = collectingLogger()

    const ref = await recordSlotRef(block(slope.slice(0, 10)), SLOT, {
      store,
      tipAccounts: TIP_ACCOUNTS,
      logger,
      minSamples: 10,
    })

    expect(ref?.sampleCount).toBe(10)
    // Найближчий ранг: десятий процентиль десяти спостережень — найдешевше з них.
    expect(store.saved[0]?.refLamports).toBe(5000n)
  })

  // Мовчазно проковтнутий збій запису дав би слот із посадками й без еталона,
  // не відрізнимий від слота, у якого еталона немає за FR-032.
  it('lets a storage failure through to the caller', async () => {
    const { logger } = collectingLogger()
    const failing: SlotRefStore = { save: () => Promise.reject(new Error('немає зʼєднання')) }

    await expect(
      recordSlotRef(block(slope), SLOT, { store: failing, tipAccounts: TIP_ACCOUNTS, logger }),
    ).rejects.toThrow('немає зʼєднання')
  })
})
