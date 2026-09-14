import { buildChannelRegistry, createLogger, DEFAULT_REGISTRY } from '@fairlane/shared'
import type { Block, BlockTransaction } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { createSlotHandler, runMaintenance } from './index.ts'
import type { LandingRow, LandingStore } from './persist.ts'
import type { SlotRefRow, SlotRefStore } from './reference.ts'
import type { RetentionStore } from './retention.ts'
import type { GroupHourlyRow, HourlyLanding, RollupStore } from './rollup.ts'

const registry = buildChannelRegistry(DEFAULT_REGISTRY)
const silent = createLogger({ level: 'fatal', sink: () => {} })

const JITO_TIP = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'
const SLOT = 341_882_103

function tx(signature: string, tip = 0, fee = 5000): BlockTransaction {
  const accountKeys = tip > 0 ? ['payer', JITO_TIP] : ['payer']

  return {
    transaction: { signatures: [signature], message: { accountKeys, instructions: [] } },
    meta: {
      err: null,
      fee,
      computeUnitsConsumed: 42_000,
      preBalances: accountKeys.map(() => 1_000_000),
      postBalances: accountKeys.map((key) => 1_000_000 + (key === JITO_TIP ? tip : 0)),
    },
  }
}

function block(transactions: BlockTransaction[]): Block {
  return { blockhash: 'hash', parentSlot: SLOT - 1, blockTime: 1_800_000_000, transactions }
}

/** Достатньо успішних невотингових, щоб слот отримав еталон (FR-032). */
function fullBlock(): Block {
  return block(
    Array.from({ length: 60 }, (_, index) =>
      tx(`sig-${index}`, index === 0 ? 200_000 : 0, index === 0 ? 9700 : 5000),
    ),
  )
}

function stores(): {
  readonly slotRefs: SlotRefStore
  readonly landings: LandingStore
  readonly order: string[]
  readonly savedRefs: SlotRefRow[]
  readonly savedLandings: LandingRow[]
} {
  const order: string[] = []
  const savedRefs: SlotRefRow[] = []
  const savedLandings: LandingRow[] = []

  return {
    order,
    savedRefs,
    savedLandings,
    slotRefs: {
      save: (row) => {
        order.push('ref')
        savedRefs.push(row)
        return Promise.resolve()
      },
    },
    landings: {
      save: (rows) => {
        order.push('landings')
        savedLandings.push(...rows)
        return Promise.resolve(rows.length)
      },
    },
  }
}

describe('createSlotHandler', () => {
  // Еталон рахується по всіх успішних невотингових транзакціях блока, до
  // вибірки збереження. Порахований після розбору, він міряв би не слот, а
  // те, що ми вирішили зберегти.
  it('records the slot reference before it writes the landings', async () => {
    const store = stores()
    const handle = createSlotHandler({
      registry,
      rpcSampleRate: 1,
      slotRefs: store.slotRefs,
      landings: store.landings,
      logger: silent,
    })

    await handle(fullBlock(), SLOT)

    expect(store.order).toEqual(['ref', 'landings'])
    expect(store.savedRefs[0]?.slot).toBe(SLOT)
    expect(store.savedRefs[0]?.sampleCount).toBe(60)
  })

  it('carries the reference into the overpay of every landing', async () => {
    const store = stores()
    const handle = createSlotHandler({
      registry,
      rpcSampleRate: 1,
      slotRefs: store.slotRefs,
      landings: store.landings,
      logger: silent,
    })

    await handle(fullBlock(), SLOT)

    const tipped = store.savedLandings.find((row) => row.groupId === 'jito')

    expect(store.savedLandings).toHaveLength(60)
    expect(tipped?.overpay).toBe(209_700n - 5000n)
  })

  // Слот без еталона не переривається: посадки зберігаються з порожнім
  // надлишком (FR-032).
  it('still writes the landings of a slot too thin for a reference', async () => {
    const store = stores()
    const handle = createSlotHandler({
      registry,
      rpcSampleRate: 1,
      slotRefs: store.slotRefs,
      landings: store.landings,
      logger: silent,
    })

    await handle(block([tx('lonely', 200_000, 9700)]), SLOT)

    expect(store.savedRefs).toEqual([])
    expect(store.savedLandings).toHaveLength(1)
    expect(store.savedLandings[0]?.overpay).toBeNull()
  })
})

function maintenanceStores(rollupFails = false): {
  readonly rollup: RollupStore
  readonly retention: RetentionStore
  readonly order: string[]
} {
  const order: string[] = []
  const hourly: readonly HourlyLanding[] = [
    { groupId: 'jito', totalCost: 100_000n, overpay: 90_000n, isSampled: false },
  ]

  return {
    order,
    rollup: {
      loadHour: () => {
        if (rollupFails) return Promise.reject(new Error('база недоступна'))
        return Promise.resolve(hourly)
      },
      save: (_rows: readonly GroupHourlyRow[]) => {
        order.push('rollup')
        return Promise.resolve()
      },
    },
    retention: {
      aggregatedThrough: () => Promise.resolve(new Date('2026-08-28T13:00:00.000Z')),
      deleteLandings: () => {
        order.push('retention')
        return Promise.resolve(0)
      },
      deleteSlotRefs: () => Promise.resolve(0),
      deleteAggregates: () => Promise.resolve(0),
    },
  }
}

describe('runMaintenance', () => {
  // Дочитане має потрапити в агрегат того самого проходу: інакше година,
  // заповнена заднім числом, згорнеться лише наступного разу — а до
  // наступного разу її посадок може вже не бути (FR-009, FR-043).
  it('heals the gaps before it rolls up', async () => {
    const store = maintenanceStores()
    const order = store.order

    await runMaintenance({
      gaps: {
        store: {
          lastObservedSlot: () => Promise.resolve(null),
          open: () => Promise.resolve(),
          listOpen: () => {
            order.push('gaps')
            return Promise.resolve([])
          },
          narrow: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        rpc: {
          getSlot: () => Promise.resolve(1_000_000),
          getBlock: () => Promise.reject(new Error('не має викликатись')),
        },
        onSlot: () => Promise.resolve(),
        sampleEveryN: 100,
        logger: silent,
        ttlHours: 48,
      },
      rollup: store.rollup,
      retention: store.retention,
      rpcSampleRate: 0.05,
      logger: silent,
      now: new Date('2026-08-28T14:20:00.000Z'),
    })

    expect(order[0]).toBe('gaps')
    expect(order.at(-1)).toBe('retention')
  })

  // Борг зачекає до наступного проходу, а згортка чекати не може: її вікно
  // вужче за строк зберігання.
  it('rolls up even when the gap pass fails', async () => {
    const store = maintenanceStores()

    await runMaintenance({
      gaps: {
        store: {
          lastObservedSlot: () => Promise.resolve(null),
          open: () => Promise.resolve(),
          listOpen: () => Promise.reject(new Error('база недоступна')),
          narrow: () => Promise.resolve(),
          close: () => Promise.resolve(),
        },
        rpc: {
          getSlot: () => Promise.resolve(1_000_000),
          getBlock: () => Promise.reject(new Error('не має викликатись')),
        },
        onSlot: () => Promise.resolve(),
        sampleEveryN: 100,
        logger: silent,
        ttlHours: 48,
      },
      rollup: store.rollup,
      retention: store.retention,
      rpcSampleRate: 0.05,
      logger: silent,
      now: new Date('2026-08-28T14:20:00.000Z'),
    })

    expect(store.order).toContain('rollup')
    expect(store.order.at(-1)).toBe('retention')
  })

  // Агрегат рахується з потранзакційних записів, поки вони ще є; після
  // видалення відновити його нема з чого (FR-043).
  it('rolls up before it clears', async () => {
    const store = maintenanceStores()

    await runMaintenance({
      rollup: store.rollup,
      retention: store.retention,
      rpcSampleRate: 0.05,
      logger: silent,
      now: new Date('2026-08-28T14:20:00.000Z'),
    })

    expect(store.order).toEqual(['rollup', 'rollup', 'rollup', 'retention'])
  })

  it('does not clear anything when the rollup fails', async () => {
    const store = maintenanceStores(true)

    await expect(
      runMaintenance({
        rollup: store.rollup,
        retention: store.retention,
        rpcSampleRate: 0.05,
        logger: silent,
        now: new Date('2026-08-28T14:20:00.000Z'),
      }),
    ).rejects.toThrow('база недоступна')

    expect(store.order).toEqual([])
  })
})
