import {
  buildChannelRegistry,
  createLogger,
  DEFAULT_REGISTRY,
  historySchema,
  MAX_HISTORY_HOURS,
  type HourlyPoint,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { historyRoute, type HistoryStore } from './history.ts'

const NOW = new Date('2026-08-28T18:34:00.000Z')
const registry = buildChannelRegistry(DEFAULT_REGISTRY)
const silent = createLogger({ level: 'fatal', sink: () => {} })

const points: readonly HourlyPoint[] = [
  {
    groupId: 'jito',
    hour: new Date('2026-08-28T17:00:00.000Z'),
    landings: 4635,
    observations: 4635,
    costP50: 11_260n,
    overpayP50: 6_260n,
    share: 0.1096,
  },
  {
    groupId: 'rpc',
    hour: new Date('2026-08-28T17:00:00.000Z'),
    landings: 27_780,
    observations: 1389,
    costP50: 6_130n,
    overpayP50: 1_130n,
    share: 0.657,
  },
]

type Call = { readonly from: Date; readonly to: Date }

function fakeStore(): HistoryStore & { readonly calls: Call[] } {
  const calls: Call[] = []

  return {
    calls,
    read: (from, to) => {
      calls.push({ from, to })
      return Promise.resolve(points)
    },
  }
}

function route(store: HistoryStore, cacheTtlMs = 0) {
  return historyRoute({
    store,
    groups: registry.groups,
    logger: silent,
    cacheTtlMs,
    now: () => NOW,
  })
}

describe('GET /v1/history', () => {
  it('answers without a key and returns a payload the shared schema accepts', async () => {
    const response = await route(fakeStore()).request('/v1/history')

    expect(response.status).toBe(200)
    expect(historySchema.safeParse(await response.json()).success).toBe(true)
  })

  it('defaults to a day and takes the depth from the query', async () => {
    const store = fakeStore()
    const app = route(store)

    await app.request('/v1/history')
    await app.request('/v1/history?hours=6')

    expect(store.calls[0]?.to.toISOString()).toBe('2026-08-28T18:00:00.000Z')
    expect(store.calls[0]?.from.toISOString()).toBe('2026-08-27T18:00:00.000Z')
    expect(store.calls[1]?.from.toISOString()).toBe('2026-08-28T12:00:00.000Z')
  })

  it('rejects a depth beyond the aggregate retention', async () => {
    const response = await route(fakeStore()).request(`/v1/history?hours=${MAX_HISTORY_HOURS + 1}`)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })

  it('rejects a depth that is not a whole number of hours', async () => {
    expect((await route(fakeStore()).request('/v1/history?hours=nope')).status).toBe(400)
    expect((await route(fakeStore()).request('/v1/history?hours=0')).status).toBe(400)
  })

  it('reads the aggregates once per depth while the cache holds', async () => {
    const store = fakeStore()
    const app = route(store, 60_000)

    await Promise.all([app.request('/v1/history'), app.request('/v1/history')])
    await app.request('/v1/history')
    await app.request('/v1/history?hours=6')

    expect(store.calls).toHaveLength(2)
  })

  it('says how deep the history actually goes, not how deep it was asked to', async () => {
    const response = await route(fakeStore()).request('/v1/history')
    const body = historySchema.parse(await response.json())

    expect(body).toMatchObject({ hours: 24, coveredHours: 1 })
    expect(body.series.map((series) => series.groupId).sort()).toEqual(['jito', 'rpc'])
  })
})
