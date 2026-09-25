import { createLogger, generateKeyToken, hashKeyToken } from '@fairlane/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { KeyIdentity, KeyStore } from '../routes/keys.ts'
import {
  addressFromHeaders,
  createBucketStore,
  rateLimit,
  refill,
  REVOKED_KEY,
  take,
  UNKNOWN_KEY,
  UNLIMITED_PATHS,
  WINDOW_MS,
  type Bucket,
} from './rateLimit.ts'

const T0 = 1_000_000

describe('take', () => {
  it('lets a fresh caller spend the whole capacity and no more', () => {
    let bucket: Bucket | undefined

    for (let i = 0; i < 5; i += 1) {
      const verdict = take(bucket, 5, T0)

      expect(verdict.allowed).toBe(true)
      bucket = verdict.bucket
    }

    expect(take(bucket, 5, T0).allowed).toBe(false)
  })

  it('says how long the refusal lasts, and it is one token’s worth of time', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 }

    expect(take(empty, 60, T0).retryAfterMs).toBe(WINDOW_MS / 60)
    expect(take(empty, 10, T0).retryAfterMs).toBe(WINDOW_MS / 10)
  })

  it('refills in proportion to the time that passed, not at a window edge', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 }

    expect(refill(empty, 10, T0 + WINDOW_MS / 2).tokens).toBe(5)
    expect(refill(empty, 10, T0 + WINDOW_MS / 10).tokens).toBe(1)
  })

  it('never hands out more than the capacity, however long the wait', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 }

    expect(refill(empty, 10, T0 + WINDOW_MS * 100).tokens).toBe(10)
  })

  it('treats a clock that went backwards as no time at all', () => {
    const half: Bucket = { tokens: 5, updatedAt: T0 }

    expect(refill(half, 10, T0 - WINDOW_MS).tokens).toBe(5)
  })

  it('answers without spending when asked not to', () => {
    const one: Bucket = { tokens: 1, updatedAt: T0 }

    expect(take(one, 10, T0, false)).toMatchObject({ allowed: true, bucket: { tokens: 1 } })
    expect(take(one, 10, T0, true)).toMatchObject({ allowed: true, bucket: { tokens: 0 } })
  })
})

describe('createBucketStore', () => {
  it('keeps the buckets apart', () => {
    const store = createBucketStore()

    expect(store.take('a', 1, T0).allowed).toBe(true)
    expect(store.take('a', 1, T0).allowed).toBe(false)
    expect(store.take('b', 1, T0).allowed).toBe(true)
  })

  it('forgets a bucket that has had a whole window to refill', () => {
    const store = createBucketStore(1)

    store.take('spent', 1, T0)
    store.take('fresh', 1, T0 + WINDOW_MS)

    expect(store.size).toBe(1)
    // The forgotten caller starts over, which is what a full bucket means.
    expect(store.take('spent', 1, T0 + WINDOW_MS).allowed).toBe(true)
  })

  it('stays bounded when every bucket is young', () => {
    const store = createBucketStore(10)

    for (let i = 0; i < 200; i += 1) store.take(`ip:${i}`, 1, T0)

    expect(store.size).toBeLessThanOrEqual(10)
  })
})

describe('addressFromHeaders', () => {
  const headers = (value?: string) =>
    ({
      req: { header: (name: string) => (name === 'x-forwarded-for' ? value : undefined) },
      // biome-ignore lint/suspicious/noExplicitAny: a context stub of two fields
    }) as any

  it('takes the hop the proxy appended, not the one the caller wrote', () => {
    expect(addressFromHeaders(headers('9.9.9.9, 203.0.113.7'))).toBe('203.0.113.7')
  })

  it('reads a single address', () => {
    expect(addressFromHeaders(headers('203.0.113.7'))).toBe('203.0.113.7')
  })

  it.each([
    ['one internal hop after the caller', '203.0.113.7, 10.0.4.9'],
    ['two of them', '203.0.113.7, 10.0.4.9, 172.20.1.3'],
    ['a rotating one — the three buckets measured on Render', '203.0.113.7, 10.201.7.44'],
    ['loopback', '203.0.113.7, 127.0.0.1'],
    ['carrier-grade NAT', '203.0.113.7, 100.64.3.9'],
    ['link-local', '203.0.113.7, 169.254.8.1'],
    ['an IPv6 unique-local hop', '203.0.113.7, fd00::1'],
  ])('ignores %s', (_case, value) => {
    expect(addressFromHeaders(headers(value))).toBe('203.0.113.7')
  })

  it('still cannot be fooled by a forged entry when internal hops follow', () => {
    // The forgery sits to the left of what our own edge appended.
    expect(addressFromHeaders(headers('1.2.3.4, 203.0.113.7, 10.0.4.9'))).toBe('203.0.113.7')
    expect(addressFromHeaders(headers('1.2.3.4, 5.6.7.8, 203.0.113.7, 10.0.4.9'))).toBe(
      '203.0.113.7',
    )
  })

  it('drops the port a proxy may append to the address', () => {
    expect(addressFromHeaders(headers('203.0.113.7:54321, 10.0.4.9'))).toBe('203.0.113.7')
    expect(addressFromHeaders(headers('[2001:db8::5]:443, 10.0.4.9'))).toBe('2001:db8::5')
  })

  it('keeps a bare IPv6 address whole', () => {
    expect(addressFromHeaders(headers('2001:db8::5, 10.0.4.9'))).toBe('2001:db8::5')
  })

  it('uses the last hop when nothing in the chain is routable', () => {
    // The local and single-proxy case, where the last hop is the right answer.
    expect(addressFromHeaders(headers('10.0.4.9, 127.0.0.1'))).toBe('127.0.0.1')
  })

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a header of commas', ' , , '],
  ])('falls back to one bucket for everyone on %s', (_case, value) => {
    expect(addressFromHeaders(headers(value))).toBe('unknown')
  })
})

/** A store that answers only what the limiter asks, and records the asking. */
type FakeStore = KeyStore & {
  readonly lookups: string[]
  readonly usage: { keyId: string; at: Date }[]
}

function fakeStore(keys: Map<string, KeyIdentity>): FakeStore {
  const lookups: string[] = []
  const usage: { keyId: string; at: Date }[] = []

  return {
    lookups,
    usage,
    findByHash: (keyHash) => {
      lookups.push(keyHash)

      return Promise.resolve(keys.get(keyHash))
    },
    recordUsage: (keyId, at) => {
      usage.push({ keyId, at })

      return Promise.resolve()
    },
    issue: () => Promise.reject(new Error('видача у цих тестах не задіяна')),
    revoke: () => Promise.reject(new Error('відкликання у цих тестах не задіяне')),
  }
}

type Live = { readonly token: string; readonly id: string }

async function withKeys(...ids: readonly string[]): Promise<{
  readonly store: FakeStore
  readonly live: Live[]
  readonly revoked: Live
}> {
  const keys = new Map<string, KeyIdentity>()
  const live: Live[] = []

  for (const id of ids) {
    const token = generateKeyToken()

    keys.set(await hashKeyToken(token), { id, revokedAt: null })
    live.push({ token, id })
  }

  const revokedToken = generateKeyToken()

  keys.set(await hashKeyToken(revokedToken), {
    id: 'revoked-key',
    revokedAt: new Date('2026-09-25T09:00:00.000Z'),
  })

  return { store: fakeStore(keys), live, revoked: { token: revokedToken, id: 'revoked-key' } }
}

/** A single route under the limiter: the limiter is what is being tested. */
function limited(store: KeyStore, withKeyPerMin: number, noKeyPerMin: number, lines: string[] = []) {
  const app = new Hono()

  app.use(
    '*',
    rateLimit({
      store,
      logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }),
      withKeyPerMin,
      noKeyPerMin,
    }),
  )
  app.all('*', (c) => c.text('served'))

  return app
}

const hit = (app: Hono, path = '/v1/recommend', token?: string, address = '203.0.113.7') =>
  app.request(path, {
    method: 'POST',
    headers: {
      'x-forwarded-for': address,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  })

describe('rateLimit', () => {
  it.each(UNLIMITED_PATHS)('never limits the public path %s (FR-049)', async (path) => {
    const { store } = await withKeys()
    const app = limited(store, 2, 1)

    for (let i = 0; i < 5; i += 1) {
      const response = await app.request(path, { headers: { 'x-forwarded-for': '203.0.113.7' } })

      expect(response.status).toBe(200)
    }

    expect(store.lookups).toHaveLength(0)
  })

  it('limits a caller without a key by address, and lets them in first (FR-047)', async () => {
    const { store } = await withKeys()
    const app = limited(store, 120, 2)

    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(200)

    const refused = await hit(app)

    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('30')
    expect(await refused.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Use a key for a higher limit.',
        details: { retryAfterSeconds: 30 },
      },
    })
  })

  it('does not lump two addresses into one bucket', async () => {
    const { store } = await withKeys()
    const app = limited(store, 120, 1)

    expect((await hit(app, '/v1/recommend', undefined, '203.0.113.7')).status).toBe(200)
    expect((await hit(app, '/v1/recommend', undefined, '203.0.113.8')).status).toBe(200)
    expect((await hit(app, '/v1/recommend', undefined, '203.0.113.7')).status).toBe(429)
  })

  it('gives a key its own higher limit and spends nothing from the address', async () => {
    const { store, live } = await withKeys('key-a')
    const app = limited(store, 3, 2)
    const mine = live[0]?.token ?? ''

    for (let i = 0; i < 3; i += 1) expect((await hit(app, '/v1/recommend', mine)).status).toBe(200)
    expect((await hit(app, '/v1/recommend', mine)).status).toBe(429)

    // The address allowance is untouched: behind one NAT, a key and a
    // keyless caller must not limit each other.
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(200)
    expect((await hit(app)).status).toBe(429)
  })

  it('counts two keys apart, and one key together across addresses', async () => {
    const { store, live } = await withKeys('key-a', 'key-b')
    const app = limited(store, 1, 5)
    const [a, b] = live

    expect((await hit(app, '/v1/recommend', a?.token, '203.0.113.7')).status).toBe(200)
    expect((await hit(app, '/v1/recommend', b?.token, '203.0.113.7')).status).toBe(200)
    expect((await hit(app, '/v1/recommend', a?.token, '198.51.100.4')).status).toBe(429)
  })

  it('takes a token of the wrong shape for no token at all, without asking the database', async () => {
    const { store } = await withKeys()
    const app = limited(store, 120, 1)

    const response = await app.request('/v1/recommend', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer nonsense' },
    })

    expect(response.status).toBe(200)
    expect(store.lookups).toHaveLength(0)
    // It spent the keyless allowance, so the next one is refused.
    expect((await hit(app)).status).toBe(429)
  })

  it('refuses an unknown key and charges the address for the attempt', async () => {
    const { store } = await withKeys()
    const app = limited(store, 120, 2)
    const invented = generateKeyToken()

    const response = await hit(app, '/v1/recommend', invented)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(UNKNOWN_KEY)
    expect(store.lookups).toHaveLength(1)

    expect((await hit(app, '/v1/recommend', generateKeyToken())).status).toBe(401)
    // Two attempts spent the two tokens of the address bucket; the third is
    // refused before the database is asked again.
    const third = await hit(app, '/v1/recommend', generateKeyToken())

    expect(third.status).toBe(429)
    expect(store.lookups).toHaveLength(2)
  })

  it('refuses a revoked key on a route that serves data (FR-048)', async () => {
    const { store, revoked } = await withKeys()
    const app = limited(store, 120, 10)

    const response = await hit(app, '/v1/recommend', revoked.token)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(REVOKED_KEY)
    expect(store.usage).toHaveLength(0)
  })

  it('still lets a revoked key through to its own revocation, so the repeat answers', async () => {
    const { store, revoked } = await withKeys()
    const app = limited(store, 120, 10)

    const response = await app.request(`/v1/keys/${revoked.id}`, {
      method: 'DELETE',
      headers: { 'x-forwarded-for': '203.0.113.7', authorization: `Bearer ${revoked.token}` },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('served')
    // A revoked key keeps its counters; it does not keep adding to them.
    expect(store.usage).toHaveLength(0)
  })

  it('counts a served request against its key, and only a served one (FR-046)', async () => {
    const { store, live } = await withKeys('key-a')
    const app = limited(store, 1, 10)
    const mine = live[0]?.token ?? ''

    await hit(app, '/v1/recommend', mine)
    expect(store.usage.map((it) => it.keyId)).toEqual(['key-a'])

    // The second request is refused by the limit, and a refusal is not use.
    expect((await hit(app, '/v1/recommend', mine)).status).toBe(429)
    expect(store.usage).toHaveLength(1)
  })

  it('does not let a failing counter fail the request', async () => {
    const { store, live } = await withKeys('key-a')
    const lines: string[] = []
    const broken: KeyStore = {
      ...store,
      recordUsage: () => Promise.reject(new Error('база лягла')),
    }
    const app = limited(broken, 5, 5, lines)

    const response = await hit(app, '/v1/recommend', live[0]?.token)

    expect(response.status).toBe(200)
    await Promise.resolve()
    expect(lines.join('\n')).toContain('лічильник звернень не оновлено')
  })

  it('never writes a token into the log', async () => {
    const { store, live } = await withKeys('key-a')
    const lines: string[] = []
    const app = limited(store, 1, 1, lines)
    const mine = live[0]?.token ?? ''

    await hit(app, '/v1/recommend', mine)
    await hit(app, '/v1/recommend', mine)

    expect(lines.join('\n')).not.toContain(mine)
  })

  it('limits the issuing of keys, which has no key to limit by (the hole T038 left)', async () => {
    const { store } = await withKeys()
    const app = limited(store, 120, 3)

    for (let i = 0; i < 3; i += 1) {
      expect((await hit(app, '/v1/keys')).status).toBe(200)
    }

    expect((await hit(app, '/v1/keys')).status).toBe(429)
  })
})
