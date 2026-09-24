import {
  buildChannelRegistry,
  createLogger,
  DEFAULT_REGISTRY,
  staleAfterMs,
  summarySchema,
  type GroupAggregate,
  type SummaryWindowFacts,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import type { SummaryStore } from './summary.ts'

const NOW = new Date('2026-08-28T17:30:00.000Z')
const registry = buildChannelRegistry(DEFAULT_REGISTRY)
const silent = createLogger({ level: 'fatal', sink: () => {} })

function aggregate(overrides: Partial<GroupAggregate> = {}): GroupAggregate {
  return {
    groupId: 'jito',
    observations: 1242,
    landings: 1242,
    overpayObservations: 1242,
    costP10: 7_000n,
    costP50: 10_572n,
    costP90: 120_000n,
    overpayP50: 5_572n,
    ...overrides,
  }
}

const facts: SummaryWindowFacts = {
  slotsSampled: 22,
  firstBlockTime: new Date('2026-08-28T17:03:03.000Z'),
  lastBlockTime: new Date('2026-08-28T17:28:40.000Z'),
}

type Call = { readonly from: Date; readonly to: Date }

const NO_WATERMARK = { slot: null, writtenAt: null }

function fakeStore(
  aggregates: readonly GroupAggregate[] = [aggregate()],
): SummaryStore & { readonly calls: Call[] } {
  const calls: Call[] = []

  return {
    calls,
    read: (from, to) => {
      calls.push({ from, to })
      return Promise.resolve({ aggregates, facts })
    },
    watermark: () => Promise.resolve(NO_WATERMARK),
  }
}

function failingStore(): SummaryStore {
  return {
    read: () => Promise.reject(new Error('база недоступна')),
    watermark: () => Promise.resolve(NO_WATERMARK),
  }
}

function app(store: SummaryStore, cacheTtlMs = 0) {
  // Стрічка тут не задіяна, тому опитування сховища не заводиться: підписників
  // немає, а без них вузол таймера не тримає.
  return createApp({
    summary: store,
    health: { read: () => Promise.reject(new Error('health у цих тестах не задіяний')) },
    history: { read: () => Promise.reject(new Error('історія у цих тестах не задіяна')) },
    keys: {
      issue: () => Promise.reject(new Error('видача ключів у цих тестах не задіяна')),
      recordUsage: () => Promise.reject(new Error('лічильники у цих тестах не задіяні')),
    },
    groups: registry.groups,
    staleAfterMs: staleAfterMs(100),
    logger: silent,
    cacheTtlMs,
    now: () => NOW,
  }).app
}

describe('GET /v1/summary', () => {
  it('answers without a key and returns a payload the shared schema accepts', async () => {
    const response = await app(fakeStore()).request('/v1/summary')

    expect(response.status).toBe(200)
    expect(summarySchema.safeParse(await response.json()).success).toBe(true)
  })

  it('falls back to the hour window and takes it from the query when given', async () => {
    const store = fakeStore()
    const client = app(store)

    await client.request('/v1/summary')
    await client.request('/v1/summary?window=15m')

    expect(store.calls[0]?.to).toEqual(NOW)
    expect(NOW.getTime() - (store.calls[0]?.from.getTime() ?? 0)).toBe(3_600_000)
    expect(NOW.getTime() - (store.calls[1]?.from.getTime() ?? 0)).toBe(900_000)
  })

  it('rejects an unknown window with the field and the allowed values', async () => {
    const response = await app(fakeStore()).request('/v1/summary?window=7d')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'INVALID_INPUT',
        message: 'Unknown summary window',
        details: { window: ['15m', '1h', '24h'] },
      },
    })
  })

  it('serves one database read to concurrent requests for the same window', async () => {
    const store = fakeStore()
    const client = app(store, 5_000)

    await Promise.all([client.request('/v1/summary'), client.request('/v1/summary')])
    await client.request('/v1/summary')

    expect(store.calls).toHaveLength(1)
  })

  // Помилка бази, збережена в кеші, пережила б саму несправність.
  it('does not keep a failed read in the cache', async () => {
    let attempts = 0
    const client = app(
      {
        read: () => {
          attempts += 1
          return Promise.reject(new Error('база недоступна'))
        },
        watermark: () => Promise.resolve(NO_WATERMARK),
      },
      5_000,
    )

    await client.request('/v1/summary')
    await client.request('/v1/summary')

    expect(attempts).toBe(2)
  })

  it('reports a broken store as INTERNAL, not as a page of HTML', async () => {
    const response = await app(failingStore()).request('/v1/summary')

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL' } })
  })

  it('lets caches hold the answer no longer than the endpoint does', async () => {
    const response = await app(fakeStore(), 5_000).request('/v1/summary')

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=5')
  })

  it('names an unknown route in the same error shape', async () => {
    const response = await app(fakeStore()).request('/v1/nothing')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })
})
