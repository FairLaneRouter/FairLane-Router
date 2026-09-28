import {
  type ChannelGroup,
  createLogger,
  type GroupBidStats,
  generateKeyToken,
  MIN_GROUP_OBSERVATIONS,
  recommendationSchema,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import {
  type BidStatsStore,
  type IssuedRecommendation,
  NO_ADVICE,
  RECOMMEND_WINDOW_MS,
  type RecommendationLog,
  recommendRoute,
} from './recommend.ts'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const STALE_AFTER_MS = 60_000
const silent = createLogger({ level: 'fatal', sink: () => {} })

function group(id: string, patch: Partial<ChannelGroup> = {}): ChannelGroup {
  return {
    id,
    name: id,
    memberNames: [id],
    tipAccounts: [],
    isObserved: true,
    canSend: true,
    ...patch,
  }
}

function stats(groupId: string, tip: bigint, price: bigint, lastBlockTime = NOW): GroupBidStats {
  return {
    groupId,
    observations: MIN_GROUP_OBSERVATIONS,
    tipLamports: { p50: tip, p90: tip * 2n },
    priorityPriceMicroLamports: { p50: price, p90: price * 2n },
    lastBlockTime,
  }
}

/** At 200 000 CU in "cheap" mode: rpc costs 5 000 + 2 000, jito 5 000 + 1 000. */
const rpc = stats('rpc', 0n, 10_000n)
const jito = stats('jito', 1_000n, 0n)

type Call = { readonly from: Date; readonly to: Date }

function fakeStore(rows: readonly GroupBidStats[] = [rpc, jito]) {
  const calls: Call[] = []
  const store: BidStatsStore = {
    read: (from, to) => {
      calls.push({ from, to })
      return Promise.resolve(rows)
    },
  }

  return { store, calls }
}

function fakeLog(fails = false) {
  const entries: IssuedRecommendation[] = []
  const log: RecommendationLog = {
    record: (entry) => {
      entries.push(entry)
      return fails ? Promise.reject(new Error('database is down')) : Promise.resolve()
    },
  }

  return { log, entries }
}

function route(
  store: BidStatsStore,
  groups: readonly ChannelGroup[] = [group('rpc'), group('jito')],
  cacheTtlMs = 0,
  log: RecommendationLog = fakeLog().log,
) {
  return recommendRoute({
    store,
    log,
    groups,
    staleAfterMs: STALE_AFTER_MS,
    logger: silent,
    cacheTtlMs,
    now: () => NOW,
  })
}

const intent = {
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  computeUnits: 200_000,
  mode: 'cheap',
}

type Requestable = {
  request(path: string, init: RequestInit): Response | Promise<Response>
}

const post = (app: Requestable, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('POST /v1/recommend', () => {
  it('answers with the cheapest sendable group in the response schema', async () => {
    const response = await post(route(fakeStore().store), intent)
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(recommendationSchema.parse(body)).toMatchObject({
      groupId: 'jito',
      expectedCost: 6_000,
      targetSlots: 4,
      isStale: false,
      note: null,
    })
  })

  it('prices from the dashboard window ending now', async () => {
    const { store, calls } = fakeStore()
    await post(route(store), intent)

    expect(calls).toEqual([{ from: new Date(NOW.getTime() - RECOMMEND_WINDOW_MS), to: NOW }])
  })

  it('notes a cheaper group that cannot be sent through (FR-041)', async () => {
    const groups = [group('rpc'), group('jito', { name: 'Jito', canSend: false })]
    const response = await post(route(fakeStore().store, groups), intent)

    expect(await response.json()).toMatchObject({
      groupId: 'rpc',
      note: { code: 'CHEAPER_GROUP_NOT_SENDABLE', groupId: 'jito' },
    })
  })

  it('refuses an unknown field and names it', async () => {
    const response = await post(route(fakeStore().store), { ...intent, targetSlot: 2 })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', details: { field: 'targetSlot' } },
    })
  })

  it('refuses an invalid value and names its field', async () => {
    const response = await post(route(fakeStore().store), { ...intent, mode: 'turbo' })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { details: { field: 'mode' } } })
  })

  it('refuses a body that is not JSON instead of reading it as empty', async () => {
    const { store, calls } = fakeStore()
    const response = await post(route(store), '{"programId":')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(calls).toHaveLength(0)
  })

  it('answers 503 rather than an invented price when nothing sendable has evidence', async () => {
    const response = await post(route(fakeStore([]).store), intent)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(NO_ADVICE)
  })

  it('marks stale advice instead of hiding it (FR-018)', async () => {
    const old = new Date(NOW.getTime() - 600_000)
    const response = await post(route(fakeStore([stats('rpc', 0n, 10_000n, old)]).store), intent)

    expect(await response.json()).toMatchObject({
      groupId: 'rpc',
      isStale: true,
      dataAgeMs: 600_000,
    })
  })

  it('shares one read between requests while the cache lives', async () => {
    const { store, calls } = fakeStore()
    const app = route(store, undefined, 60_000)

    await post(app, intent)
    await post(app, { ...intent, mode: 'fast', computeUnits: 1_000_000 })

    expect(calls).toHaveLength(1)
  })

  it('does not keep a failed read for the life of the cache', async () => {
    let fail = true
    const calls: Call[] = []
    const store: BidStatsStore = {
      read: (from, to) => {
        calls.push({ from, to })
        if (fail) return Promise.reject(new Error('database is down'))
        return Promise.resolve([rpc])
      },
    }
    const app = route(store, undefined, 60_000)

    expect((await post(app, intent)).status).toBe(500)
    fail = false
    expect((await post(app, intent)).status).toBe(200)
    expect(calls).toHaveLength(2)
  })
})

describe('POST /v1/recommend keeps what it advised (T046)', () => {
  const rpcOnly = [group('rpc'), group('jito', { canSend: false })]

  it('records the advice with the priority fee in lamports for these units', async () => {
    const { log, entries } = fakeLog()
    await post(route(fakeStore().store, rpcOnly, 0, log), intent)

    expect(entries).toEqual([
      {
        keyId: null,
        mode: 'cheap',
        groupId: 'rpc',
        tipLamports: 0n,
        // 10 000 micro-lamports per unit × 200 000 units = 2 000 lamports.
        priorityFeeLamports: 2_000n,
        expectedCost: 7_000n,
        dataAgeMs: 0,
        wasStale: false,
      },
    ])
  })

  it('records stale advice as stale', async () => {
    const { log, entries } = fakeLog()
    const old = new Date(NOW.getTime() - 600_000)
    await post(route(fakeStore([stats('rpc', 0n, 10_000n, old)]).store, rpcOnly, 0, log), intent)

    expect(entries[0]).toMatchObject({ wasStale: true, dataAgeMs: 600_000 })
  })

  it('records nothing it did not advise', async () => {
    const { log, entries } = fakeLog()
    await post(route(fakeStore().store, rpcOnly, 0, log), { ...intent, mode: 'turbo' })
    await post(route(fakeStore([]).store, rpcOnly, 0, log), intent)

    expect(entries).toEqual([])
  })

  it('still answers when the record cannot be written', async () => {
    const lines: string[] = []
    const response = await recommendRoute({
      store: fakeStore().store,
      log: fakeLog(true).log,
      groups: rpcOnly,
      staleAfterMs: STALE_AFTER_MS,
      logger: createLogger({ level: 'error', sink: (line) => lines.push(line) }),
      cacheTtlMs: 0,
      now: () => NOW,
    }).request('/v1/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(response.status).toBe(200)
    expect(lines.some((line) => line.includes('advice not recorded'))).toBe(true)
  })
})

describe('POST /v1/recommend in the assembled app', () => {
  function app(log: RecommendationLog = fakeLog().log) {
    return createApp({
      summary: {
        read: () => Promise.reject(new Error('the summary is not used in these tests')),
        watermark: () => Promise.reject(new Error('the summary is not used in these tests')),
      },
      health: { read: () => Promise.reject(new Error('health is not used in these tests')) },
      history: { read: () => Promise.reject(new Error('history is not used in these tests')) },
      keys: {
        issue: () => Promise.reject(new Error('key issuance is not used in these tests')),
        recordUsage: () => Promise.reject(new Error('counters are not used in these tests')),
        revoke: () => Promise.reject(new Error('revocation is not used in these tests')),
        findByHash: () => Promise.resolve({ id: 'key-1', revokedAt: null }),
      },
      bids: fakeStore().store,
      advice: log,
      groups: [group('rpc'), group('jito')],
      staleAfterMs: STALE_AFTER_MS,
      rateLimitWithKeyPerMin: 120,
      rateLimitNoKeyPerMin: 10,
      logger: silent,
      cacheTtlMs: 0,
      now: () => NOW,
    }).app
  }

  it('serves a keyless caller at the stricter allowance, not without limit (FR-047)', async () => {
    const assembled = app()
    const statuses: number[] = []

    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await post(assembled, intent)).status)
    }

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses[10]).toBe(429)
  })

  it('records whose key paid for the advice', async () => {
    const { log, entries } = fakeLog()
    await post(app(log), intent, { authorization: `Bearer ${generateKeyToken()}` })

    expect(entries[0]?.keyId).toBe('key-1')
  })
})
