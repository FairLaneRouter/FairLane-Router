import type { Block, RpcClient } from '@fairlane/shared'
import { createLogger, SlotSkippedError } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import {
  detectRestartGap,
  gapHorizonSlots,
  healGaps,
  sampleSlotsInRange,
  type GapStore,
  type OpenGap,
} from './gaps.ts'

const silent = createLogger({ level: 'fatal', sink: () => {} })
const TTL_HOURS = 48
const HEAD = 1_000_000

const block = (slot: number): Block => ({
  blockhash: `hash-${slot}`,
  parentSlot: slot - 1,
  blockTime: 1_800_000_000,
  transactions: [],
})

function fakeRpc(failures: Map<number, Error> = new Map()): RpcClient & { asked: number[] } {
  const asked: number[] = []

  return {
    asked,
    getSlot: () => Promise.resolve(HEAD),
    getBlock: (slot) => {
      asked.push(slot)
      const failure = failures.get(slot)
      return failure ? Promise.reject(failure) : Promise.resolve(block(slot))
    },
  }
}

type FakeStore = GapStore & {
  readonly narrowed: { id: string; fromSlot: number }[]
  readonly closed: string[]
  readonly opened: { fromSlot: number; toSlot: number; reason: string }[]
}

function fakeStore(open: readonly OpenGap[], lastObserved: number | null = null): FakeStore {
  const narrowed: { id: string; fromSlot: number }[] = []
  const closed: string[] = []
  const opened: { fromSlot: number; toSlot: number; reason: string }[] = []

  return {
    narrowed,
    closed,
    opened,
    lastObservedSlot: () => Promise.resolve(lastObserved),
    open: (gap) => {
      opened.push(gap)
      return Promise.resolve()
    },
    listOpen: (limit) => Promise.resolve(open.slice(0, limit)),
    narrow: (id, fromSlot) => {
      narrowed.push({ id, fromSlot })
      return Promise.resolve()
    },
    close: (id) => {
      closed.push(id)
      return Promise.resolve()
    },
  }
}

const gap = (overrides: Partial<OpenGap> = {}): OpenGap => ({
  id: 'gap-1',
  fromSlot: 999_001,
  toSlot: 999_400,
  reason: 'restart',
  ...overrides,
})

describe('sampleSlotsInRange', () => {
  it('walks the sampling grid, not every slot', () => {
    expect(sampleSlotsInRange(1_001, 1_400, 100)).toEqual([1_100, 1_200, 1_300, 1_400])
  })

  it('keeps a boundary that already sits on the grid', () => {
    expect(sampleSlotsInRange(1_100, 1_300, 100)).toEqual([1_100, 1_200, 1_300])
  })

  it('finds nothing in a range that carries no grid slot', () => {
    expect(sampleSlotsInRange(1_101, 1_199, 100)).toEqual([])
  })
})

describe('detectRestartGap', () => {
  // Цикл починає з наступного слота після голови, а не з місця зупинки:
  // доганяти всередині циклу означало б відставати тим більше, чим довший
  // був простій.
  it('takes the break between the last slot seen and the new start', () => {
    expect(detectRestartGap(1_000, 1_500, 100)).toEqual({ fromSlot: 1_001, toSlot: 1_499 })
  })

  it('reports nothing on the very first run', () => {
    expect(detectRestartGap(null, 1_500, 100)).toBeNull()
  })

  it('reports nothing when the loop simply carries on', () => {
    expect(detectRestartGap(1_400, 1_500, 100)).toBeNull()
  })

  it('reports nothing when the break holds no sampling slot', () => {
    expect(detectRestartGap(1_500, 1_599, 100)).toBeNull()
  })
})

describe('gapHorizonSlots', () => {
  it('measures the storage term in slots', () => {
    expect(gapHorizonSlots(48)).toBe(432_000)
  })
})

describe('healGaps', () => {
  it('reads the sampling slots of the gap and closes it', async () => {
    const store = fakeStore([gap()])
    const rpc = fakeRpc()
    const seen: number[] = []

    const report = await healGaps({
      store,
      rpc,
      onSlot: (_block, slot) => {
        seen.push(slot)
        return Promise.resolve()
      },
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
    })

    expect(seen).toEqual([999_100, 999_200, 999_300, 999_400])
    expect(store.closed).toEqual(['gap-1'])
    expect(report).toMatchObject({ slots: 4, closed: 1, abandoned: 0 })
  })

  // Борг віддається рівномірно: прохід, що займає процес надовго, змусив би
  // його відстати від голови, а свіжий слот не наздоганяє себе сам.
  it('stops at the budget and narrows the gap to where it stopped', async () => {
    const store = fakeStore([gap()])
    const rpc = fakeRpc()

    const report = await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
      maxSlotsPerPass: 2,
    })

    expect(rpc.asked).toEqual([999_100, 999_200])
    expect(store.narrowed).toEqual([{ id: 'gap-1', fromSlot: 999_300 }])
    expect(store.closed).toEqual([])
    expect(report.remaining).toBe(1)
  })

  it('stops the gap on the slot that failed, so the next pass retries it', async () => {
    const store = fakeStore([gap()])
    const rpc = fakeRpc(new Map([[999_200, new Error('502 від провайдера')]]))

    await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
    })

    expect(store.narrowed).toEqual([{ id: 'gap-1', fromSlot: 999_200 }])
    expect(store.closed).toEqual([])
  })

  // Пропущений слот заповнити нічим: його не існує і не з'явиться.
  it('walks over a slot that is skipped in the ledger', async () => {
    const store = fakeStore([gap()])
    const rpc = fakeRpc(new Map([[999_200, new SlotSkippedError(999_200, -32009)]]))

    const report = await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
    })

    expect(store.closed).toEqual(['gap-1'])
    expect(report.slots).toBe(3)
  })

  // Дочитане за строком зберігання прожило б годину-дві й пішло під TTL, а
  // запити до платного RPC витрачені повністю.
  it('abandons a gap older than the storage term instead of paying for it', async () => {
    const store = fakeStore([gap({ fromSlot: 100, toSlot: 400 })])
    const rpc = fakeRpc()
    const lines: string[] = []

    const report = await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: createLogger({ level: 'warn', sink: (line) => lines.push(line) }),
      ttlHours: TTL_HOURS,
    })

    expect(rpc.asked).toEqual([])
    expect(store.closed).toEqual(['gap-1'])
    expect(report).toMatchObject({ abandoned: 1, closed: 0 })
    expect(lines.join('\n')).toContain('невідновна')
  })

  it('starts an oversized gap at the horizon, not at its own beginning', async () => {
    const store = fakeStore([gap({ fromSlot: 100, toSlot: 999_400 })])
    const rpc = fakeRpc()

    await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
      maxSlotsPerPass: 1,
    })

    expect(rpc.asked).toEqual([568_000])
  })

  it('asks the chain for nothing while no gap is open', async () => {
    const store = fakeStore([])
    const rpc = fakeRpc()

    const report = await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
    })

    expect(rpc.asked).toEqual([])
    expect(report).toEqual({ slots: 0, closed: 0, abandoned: 0, remaining: 0 })
  })

  it('spends one budget across several gaps, oldest first', async () => {
    const store = fakeStore([
      gap({ id: 'gap-1', fromSlot: 999_001, toSlot: 999_200 }),
      gap({ id: 'gap-2', fromSlot: 999_401, toSlot: 999_600 }),
    ])
    const rpc = fakeRpc()

    await healGaps({
      store,
      rpc,
      onSlot: () => Promise.resolve(),
      sampleEveryN: 100,
      logger: silent,
      ttlHours: TTL_HOURS,
      maxSlotsPerPass: 3,
    })

    expect(rpc.asked).toEqual([999_100, 999_200, 999_500])
    expect(store.closed).toEqual(['gap-1'])
    expect(store.narrowed).toEqual([{ id: 'gap-2', fromSlot: 999_600 }])
  })
})
