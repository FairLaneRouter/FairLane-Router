import { createLogger, staleAfterMs } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { healthRoute } from './health.ts'
import {
  assessIndexer,
  GAP_STUCK_AFTER_MS,
  type HealthStore,
  type IndexerState,
} from './health.ts'

const NOW = new Date('2026-08-28T18:00:00.000Z')
const STALE_AFTER = staleAfterMs(100)
const silent = createLogger({ level: 'fatal', sink: () => {} })

function state(overrides: Partial<IndexerState> = {}): IndexerState {
  return {
    lastSlot: 442_395_200,
    lastBlockTime: new Date(NOW.getTime() - 40_000),
    lastWriteAt: new Date(NOW.getTime() - 30_000),
    openGaps: 0,
    oldestOpenGapAt: null,
    ...overrides,
  }
}

function assess(overrides: Partial<IndexerState> = {}) {
  return assessIndexer({ state: state(overrides), now: NOW, staleAfterMs: STALE_AFTER })
}

describe('assessIndexer', () => {
  it('calls a pipeline that keeps up healthy', () => {
    expect(assess()).toMatchObject({ status: 'ok', issues: [], lagMs: 40_000, lagSlots: 100 })
  })

  it('measures the lag from the newest landing, without asking the chain', () => {
    const report = assess({ lastBlockTime: new Date(NOW.getTime() - 12_000) })

    expect(report.lagMs).toBe(12_000)
    expect(report.lagSlots).toBe(30)
  })

  it('degrades when collection falls behind the freshness threshold', () => {
    const report = assess({ lastBlockTime: new Date(NOW.getTime() - STALE_AFTER - 1) })

    expect(report.status).toBe('degraded')
    expect(report.issues).toContain('збір відстає від ланцюга')
  })

  it('degrades on an empty store instead of reporting a lag of nothing', () => {
    const report = assess({ lastSlot: null, lastBlockTime: null, lastWriteAt: null })

    expect(report).toMatchObject({ status: 'degraded', lagMs: null, lagSlots: null })
    expect(report.issues).toContain('жодної посадки у сховищі')
  })

  // Розрив від перезапуску відкривається щоразу і закривається наступним
  // проходом обслуговування — тривогою це бути не може.
  it('does not treat a fresh open gap as a fault', () => {
    const report = assess({ openGaps: 1, oldestOpenGapAt: new Date(NOW.getTime() - 60_000) })

    expect(report.status).toBe('ok')
    expect(report.openGaps).toBe(1)
  })

  it('degrades on a gap that outlived two maintenance passes', () => {
    const report = assess({
      openGaps: 2,
      oldestOpenGapAt: new Date(NOW.getTime() - GAP_STUCK_AFTER_MS - 1),
    })

    expect(report.status).toBe('degraded')
    expect(report.issues).toContain('прогалина не закривається два проходи поспіль')
  })

  it('reports every fault at once, not just the first', () => {
    const report = assess({
      lastBlockTime: new Date(NOW.getTime() - STALE_AFTER - 1),
      openGaps: 1,
      oldestOpenGapAt: new Date(NOW.getTime() - GAP_STUCK_AFTER_MS - 1),
    })

    expect(report.issues).toHaveLength(2)
  })

  // Годинник вузла бази й годинник процесу — різні годинники.
  it('never reports a negative lag', () => {
    expect(assess({ lastBlockTime: new Date(NOW.getTime() + 5_000) }).lagMs).toBe(0)
  })
})

function route(store: HealthStore) {
  return healthRoute({ store, staleAfterMs: STALE_AFTER, logger: silent, now: () => NOW })
}

describe('GET /health', () => {
  it('answers with the state of collection', async () => {
    const response = await route({ read: () => Promise.resolve(state()) }).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', lastSlot: 442_395_200 })
  })

  // 503 змусив би платформу перезапускати API через зупинку індексатора —
  // іншого процесу, якому перезапуск сусіда ніяк не допоможе.
  it('stays 200 while degraded, and says so in the body', async () => {
    const store = { read: () => Promise.resolve(state({ lastSlot: null, lastBlockTime: null })) }
    const response = await route(store).request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'degraded' })
  })

  it('is never served from a cache', async () => {
    const response = await route({ read: () => Promise.resolve(state()) }).request('/health')

    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
