import {
  buildChannelRegistry,
  createLogger,
  DEFAULT_REGISTRY,
  staleAfterMs,
  summarySchema,
  type GroupAggregate,
  type Summary,
  type SummaryWindowFacts,
} from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { createSummaryHub, type SummaryHubOptions } from './stream.ts'
import type { SummaryProvider, SummaryStore, Watermark } from './summary.ts'

const NOW = new Date('2026-08-28T17:30:00.000Z')
const registry = buildChannelRegistry(DEFAULT_REGISTRY)
const silent = createLogger({ level: 'fatal', sink: () => {} })

const aggregates: readonly GroupAggregate[] = [
  {
    groupId: 'jito',
    observations: 1242,
    landings: 1242,
    overpayObservations: 1242,
    costP10: 7_000n,
    costP50: 10_572n,
    costP90: 120_000n,
    overpayP50: 5_572n,
  },
]

const facts: SummaryWindowFacts = {
  slotsSampled: 22,
  firstBlockTime: new Date('2026-08-28T17:03:03.000Z'),
  lastBlockTime: new Date('2026-08-28T17:28:40.000Z'),
}

/** Сховище, чий обрій рухається рівно тоді, коли того просить тест. */
function movableStore(): SummaryStore & {
  advance(): void
  readonly reads: number
  readonly polls: number
} {
  let written = new Date('2026-08-28T17:28:40.000Z')
  let slot = 442_395_200
  let reads = 0
  let polls = 0

  return {
    get reads() {
      return reads
    },
    get polls() {
      return polls
    },
    advance() {
      slot += 100
      written = new Date(written.getTime() + 40_000)
    },
    read: () => {
      reads += 1
      return Promise.resolve({ aggregates, facts })
    },
    watermark: () => {
      polls += 1
      return Promise.resolve({ slot, writtenAt: written })
    },
  }
}

function countingProvider(): SummaryProvider & { readonly refreshes: number } {
  let refreshes = 0
  const summary = { window: '1h' } as unknown as Summary

  return {
    ttlMs: 0,
    get refreshes() {
      return refreshes
    },
    get: () => Promise.resolve(summary),
    refresh: () => {
      refreshes += 1
      return Promise.resolve(summary)
    },
  }
}

function hubOf(
  overrides: Partial<SummaryHubOptions> & Pick<SummaryHubOptions, 'provider' | 'watermark'>,
) {
  return createSummaryHub({ logger: silent, intervalMs: 5, ...overrides })
}

/** Дає таймерам вузла кілька обертів — інтервал у тестах мілісекундний. */
function settle(turns = 6): Promise<void> {
  return new Promise((resolve) => {
    let left = turns
    const tick = () => {
      left -= 1
      if (left <= 0) resolve()
      else setTimeout(tick, 5)
    }
    setTimeout(tick, 5)
  })
}

/**
 * Waits for a condition rather than for a stretch of time.
 *
 * The route sends the first event **before** it subscribes to the hub, so
 * "the first event arrived" says nothing about whether polling has begun.
 * Whether one had already happened by the time the other was observed used to
 * depend on the interleaving of microtasks, and a middleware added in front of
 * the route was enough to flip it.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`не сталося: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('createSummaryHub', () => {
  it('does not touch the store while nobody is listening', async () => {
    let polls = 0
    const hub = hubOf({
      provider: countingProvider(),
      watermark: () => {
        polls += 1
        return Promise.resolve({ slot: 1, writtenAt: NOW })
      },
    })

    await settle()
    expect(polls).toBe(0)

    hub.close()
  })

  it('recomputes only when the watermark moves', async () => {
    const provider = countingProvider()
    let mark: Watermark = { slot: 1, writtenAt: NOW }
    const hub = hubOf({ provider, watermark: () => Promise.resolve(mark) })

    hub.subscribe('1h', () => {})
    await settle()

    // Перший тік лише знімає відлік: першу подію маршрут надсилає сам.
    expect(provider.refreshes).toBe(0)

    mark = { slot: 2, writtenAt: new Date(NOW.getTime() + 40_000) }
    await settle()
    expect(provider.refreshes).toBe(1)

    await settle()
    expect(provider.refreshes).toBe(1)

    hub.close()
  })

  it('recomputes a window once, however many listeners it has', async () => {
    const provider = countingProvider()
    let mark: Watermark = { slot: 1, writtenAt: NOW }
    const hub = hubOf({ provider, watermark: () => Promise.resolve(mark) })

    const received: number[] = []
    hub.subscribe('1h', () => received.push(1))
    hub.subscribe('1h', () => received.push(2))
    hub.subscribe('1h', () => received.push(3))
    await settle()

    mark = { slot: 2, writtenAt: NOW }
    await settle()

    expect(provider.refreshes).toBe(1)
    expect(received).toEqual([1, 2, 3])

    hub.close()
  })

  it('stops polling when the last listener leaves', async () => {
    let polls = 0
    const hub = hubOf({
      provider: countingProvider(),
      watermark: () => {
        polls += 1
        return Promise.resolve({ slot: 1, writtenAt: NOW })
      },
    })

    const unsubscribe = hub.subscribe('1h', () => {})
    await settle()
    const whileWatching = polls
    expect(whileWatching).toBeGreaterThan(0)

    unsubscribe()
    expect(hub.size).toBe(0)
    await settle()

    expect(polls).toBe(whileWatching)
    hub.close()
  })

  // Обірваний сокет одного підписника не стосується решти.
  it('keeps delivering after a listener throws', async () => {
    const provider = countingProvider()
    let mark: Watermark = { slot: 1, writtenAt: NOW }
    const hub = hubOf({ provider, watermark: () => Promise.resolve(mark) })

    let delivered = 0
    hub.subscribe('1h', () => {
      throw new Error('сокет закрито')
    })
    hub.subscribe('1h', () => {
      delivered += 1
    })
    await settle()

    mark = { slot: 2, writtenAt: NOW }
    await settle()

    expect(delivered).toBe(1)
    hub.close()
  })

  // Несправність сховища не має рвати стрічку: підписник лишається на місці.
  it('survives a store that refuses to answer', async () => {
    const provider = countingProvider()
    let broken = true
    const hub = hubOf({
      provider,
      watermark: () =>
        broken
          ? Promise.reject(new Error('база недоступна'))
          : Promise.resolve({ slot: 2, writtenAt: NOW }),
    })

    hub.subscribe('1h', () => {})
    await settle()

    broken = false
    await settle()

    expect(hub.size).toBe(1)
    hub.close()
  })
})

type Client = {
  readonly events: { event: string; data: string }[]
  waitFor(count: number): Promise<void>
  close(): void
}

/** Читає SSE до відключення. Розділювач подій — порожній рядок. */
async function connect(app: ReturnType<typeof createApp>, path: string): Promise<Client> {
  const controller = new AbortController()
  const response = await app.app.request(path, { signal: controller.signal })
  const body = response.body
  if (body === null) throw new Error('стрічка без тіла')

  const events: { event: string; data: string }[] = []
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })

        let split = buffer.indexOf('\n\n')
        while (split !== -1) {
          const raw = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const event = /^event:\s*(.*)$/m.exec(raw)?.[1] ?? ''
          const data = /^data:\s*(.*)$/m.exec(raw)?.[1] ?? ''
          events.push({ event, data })
          split = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // Читання обривається разом зі зʼєднанням — це і є нормальний вихід.
    }
  })()

  return {
    events,
    async waitFor(count) {
      const deadline = Date.now() + 2_000
      while (events.length < count) {
        if (Date.now() > deadline) throw new Error(`подій ${events.length}, чекали ${count}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    // Обидва шляхи відключення одразу — так само, як їх бачить застосунок:
    // скасоване читання відповіді і перерваний сигнал запиту.
    close: () => {
      void reader.cancel().catch(() => {})
      controller.abort()
    },
  }
}

function streamApp(store: SummaryStore) {
  return createApp({
    summary: store,
    health: { read: () => Promise.reject(new Error('health у цих тестах не задіяний')) },
    history: { read: () => Promise.reject(new Error('історія у цих тестах не задіяна')) },
    keys: {
      issue: () => Promise.reject(new Error('видача ключів у цих тестах не задіяна')),
      recordUsage: () => Promise.reject(new Error('лічильники у цих тестах не задіяні')),
      revoke: () => Promise.reject(new Error('відкликання ключів у цих тестах не задіяне')),
      findByHash: () => Promise.reject(new Error('пошук ключів у цих тестах не задіяний')),
    },
    groups: registry.groups,
    staleAfterMs: staleAfterMs(100),
    rateLimitWithKeyPerMin: 120,
    rateLimitNoKeyPerMin: 10,
    logger: silent,
    cacheTtlMs: 0,
    watchIntervalMs: 5,
    pingIntervalMs: 50,
    now: () => NOW,
  })
}

describe('GET /v1/summary/stream', () => {
  // Сторінка, відкрита між слотами вибірки, інакше чекала б до сорока секунд.
  it('sends the current summary immediately, without waiting for a new slot', async () => {
    const app = streamApp(movableStore())
    const client = await connect(app, '/v1/summary/stream')

    await client.waitFor(1)
    expect(client.events[0]?.event).toBe('summary')
    expect(summarySchema.safeParse(JSON.parse(client.events[0]?.data ?? '')).success).toBe(true)

    client.close()
    app.close()
  })

  it('sends a summary event for every processed slot', async () => {
    const store = movableStore()
    const app = streamApp(store)
    const client = await connect(app, '/v1/summary/stream')

    await client.waitFor(1)
    await until(() => store.polls > 0, 'вузол зняв перший відлік')
    store.advance()
    await client.waitFor(2)

    expect(client.events[1]?.event).toBe('summary')
    expect(JSON.parse(client.events[1]?.data ?? '').window).toBe('1h')

    client.close()
    app.close()
  })

  it('serves the window asked for', async () => {
    const app = streamApp(movableStore())
    const client = await connect(app, '/v1/summary/stream?window=15m')

    await client.waitFor(1)
    expect(JSON.parse(client.events[0]?.data ?? '').window).toBe('15m')

    client.close()
    app.close()
  })

  // Мовчання між слотами триває довше за звичайні 30 секунд посередника.
  it('keeps the connection alive between slots', async () => {
    const app = streamApp(movableStore())
    const client = await connect(app, '/v1/summary/stream')

    await client.waitFor(2)
    expect(client.events[1]?.event).toBe('ping')

    client.close()
    app.close()
  })

  it('announces itself as an event stream that proxies must not buffer', async () => {
    const app = streamApp(movableStore())
    const response = await app.app.request('/v1/summary/stream')

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(response.headers.get('X-Accel-Buffering')).toBe('no')

    await response.body?.cancel()
    app.close()
  })

  it('rejects an unknown window the same way the plain summary does', async () => {
    const app = streamApp(movableStore())
    const response = await app.app.request('/v1/summary/stream?window=7d')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })

    app.close()
  })

  // Вкладка, яку закрили, не має коштувати нам запиту раз на п'ять секунд
  // до кінця життя процесу.
  it('stops polling the store once the client disconnects', async () => {
    const store = movableStore()
    const app = streamApp(store)
    const client = await connect(app, '/v1/summary/stream')

    await client.waitFor(1)
    await until(() => store.polls > 0, 'вузол почав опитувати сховище')
    expect(store.polls).toBeGreaterThan(0)

    client.close()
    await settle(10)
    const afterClose = store.polls
    await settle(10)

    expect(store.polls).toBe(afterClose)
    app.close()
  })
})
