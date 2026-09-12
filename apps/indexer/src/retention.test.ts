import { createLogger } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_TTL_DAYS,
  retentionCutoffs,
  runRetention,
  TRANSACTION_TTL_HOURS,
  type RetentionStore,
} from './retention.ts'

const NOW = new Date('2026-08-28T14:20:00.000Z')

const silent = createLogger({ level: 'fatal', sink: () => {} })

type FakeStore = RetentionStore & {
  readonly calls: { landings: Date[]; slotRefs: Date[]; aggregates: Date[] }
}

function fakeStore(aggregatedThrough: Date | null, deleted = 7): FakeStore {
  const calls = { landings: [] as Date[], slotRefs: [] as Date[], aggregates: [] as Date[] }

  return {
    calls,
    aggregatedThrough: () => Promise.resolve(aggregatedThrough),
    deleteLandings: (before) => {
      calls.landings.push(before)
      return Promise.resolve(deleted)
    },
    deleteSlotRefs: (before) => {
      calls.slotRefs.push(before)
      return Promise.resolve(deleted)
    },
    deleteAggregates: (before) => {
      calls.aggregates.push(before)
      return Promise.resolve(deleted)
    },
  }
}

describe('retentionCutoffs', () => {
  it('takes the two levels back by their own terms (FR-026)', () => {
    const cutoffs = retentionCutoffs(NOW)

    expect(cutoffs.transactional.toISOString()).toBe('2026-08-26T14:20:00.000Z')
    expect(cutoffs.aggregate.toISOString()).toBe('2026-05-30T14:20:00.000Z')
    expect(TRANSACTION_TTL_HOURS).toBe(48)
    expect(AGGREGATE_TTL_DAYS).toBe(90)
  })

  it('rejects a term that is not positive', () => {
    expect(() => retentionCutoffs(NOW, { transactionTtlHours: 0 })).toThrow(RangeError)
    expect(() => retentionCutoffs(NOW, { aggregateTtlDays: -1 })).toThrow(RangeError)
  })
})

describe('runRetention', () => {
  // Еталон слота живе стільки ж, скільки посадка: без нього надлишок не
  // перерахувати вручну, а саме це обіцяє сторінка методики (FR-045).
  it('clears both tables of the transactional level by one cutoff', async () => {
    const store = fakeStore(new Date('2026-08-28T13:00:00.000Z'))

    const report = await runRetention({ store, logger: silent, now: NOW })

    expect(store.calls.landings).toEqual([new Date('2026-08-26T14:20:00.000Z')])
    expect(store.calls.slotRefs).toEqual(store.calls.landings)
    expect(report.heldByRollup).toBe(false)
    expect(report).toMatchObject({ landings: 7, slotRefs: 7, aggregates: 7 })
  })

  it('clears the aggregate level by ninety days', async () => {
    const store = fakeStore(new Date('2026-08-28T13:00:00.000Z'))

    await runRetention({ store, logger: silent, now: NOW })

    expect(store.calls.aggregates).toEqual([new Date('2026-05-30T14:20:00.000Z')])
  })

  // Строк зберігання настане й тоді, коли згортка мовчки не працює. Чистка за
  // самим лише строком вимела б спостереження, яких у 90-денній історії так
  // ніколи й не з'явилось, і M4 виявив би це вже порожнім графіком.
  it('holds the cutoff back to the newest aggregated hour when the rollup lags', async () => {
    const lagging = new Date('2026-08-20T09:00:00.000Z')
    const store = fakeStore(lagging)
    const lines: string[] = []

    const report = await runRetention({
      store,
      logger: createLogger({ level: 'warn', sink: (line) => lines.push(line) }),
      now: NOW,
    })

    expect(store.calls.landings).toEqual([lagging])
    expect(report.heldByRollup).toBe(true)
    expect(lines.join('\n')).toContain('межу чистки підтягнуто до згортки')
  })

  it('deletes nothing from the transactional level while no hour has been rolled up', async () => {
    const store = fakeStore(null)

    const report = await runRetention({ store, logger: silent, now: NOW })

    expect(store.calls.landings).toEqual([])
    expect(store.calls.slotRefs).toEqual([])
    expect(report).toMatchObject({ landings: 0, slotRefs: 0, transactional: null })
  })

  // Агрегати старші за 90 днів чистяться завжди: вони самі є тим рівнем, який
  // згортка наповнює, і чекати на неї нема чого.
  it('still clears the aggregate level when the rollup has produced nothing', async () => {
    const store = fakeStore(null)

    const report = await runRetention({ store, logger: silent, now: NOW })

    expect(store.calls.aggregates).toEqual([new Date('2026-05-30T14:20:00.000Z')])
    expect(report.aggregates).toBe(7)
  })

  it('honours an overridden term', async () => {
    const store = fakeStore(new Date('2026-08-28T13:00:00.000Z'))

    await runRetention({
      store,
      logger: silent,
      now: NOW,
      transactionTtlHours: 2,
      aggregateTtlDays: 1,
    })

    expect(store.calls.landings).toEqual([new Date('2026-08-28T12:20:00.000Z')])
    expect(store.calls.aggregates).toEqual([new Date('2026-08-27T14:20:00.000Z')])
  })
})
