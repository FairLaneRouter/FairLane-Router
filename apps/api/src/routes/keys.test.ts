import { createDatabase } from '@fairlane/db'
import {
  createLogger,
  hashKeyToken,
  issuedKeySchema,
  KEY_PREFIX,
  revokedKeySchema,
  startOfHour,
} from '@fairlane/shared'
import { afterAll, describe, expect, it } from 'vitest'
import {
  INVALID_LABEL,
  keysRoute,
  MISSING_KEY,
  NO_SUCH_KEY,
  revokeStatement,
  type KeyRecord,
  type KeyStore,
  type RevokeInput,
} from './keys.ts'

const CREATED_AT = new Date('2026-09-24T12:00:00.000Z')
const ID = '6f1c0d2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f'

type Issued = { readonly keyHash: string; readonly label: string | null }

/** A row of `api_keys` as the fake store keeps it — the hash included. */
type Row = Issued & { readonly id: string; readonly createdAt: Date; revokedAt: Date | null }

type FakeStore = KeyStore & {
  readonly issued: Issued[]
  readonly rows: Row[]
  readonly revoked: RevokeInput[]
  /** Hour of the counter to the number of requests, exactly as `key_usage`. */
  readonly usage: Map<string, number>
}

/**
 * The ids differ between issues, and that matters for one test: revoking
 * somebody else’s key is only a case at all when two keys exist at once.
 */
const idOf = (n: number) => `6f1c0d2e-9a3b-4c5d-8e7f-0a1b2c3d4e${(0x5f + n).toString(16)}`

function fakeStore(clock: () => Date = () => REVOKED_AT): FakeStore {
  const issued: Issued[] = []
  const rows: Row[] = []
  const revoked: RevokeInput[] = []
  const usage = new Map<string, number>()

  return {
    issued,
    rows,
    revoked,
    usage,
    issue: (input) => {
      issued.push(input)

      const row: Row = {
        id: idOf(rows.length),
        keyHash: input.keyHash,
        label: input.label,
        createdAt: CREATED_AT,
        revokedAt: null,
      }

      rows.push(row)

      const record: KeyRecord = { id: row.id, createdAt: row.createdAt, label: row.label }

      return Promise.resolve(record)
    },
    recordUsage: (keyId, at) => {
      const cell = `${keyId}|${startOfHour(at).toISOString()}`

      usage.set(cell, (usage.get(cell) ?? 0) + 1)

      return Promise.resolve()
    },
    findByHash: (keyHash) => {
      const row = rows.find((it) => it.keyHash === keyHash)

      return Promise.resolve(row === undefined ? undefined : { id: row.id, revokedAt: row.revokedAt })
    },
    revoke: (input) => {
      revoked.push(input)

      const row = rows.find((it) => it.id === input.id && it.keyHash === input.keyHash)
      if (row === undefined) return Promise.resolve(undefined)

      // `coalesce(revoked_at, now())` in one line: the first call stamps, the
      // repeats keep the stamp.
      row.revokedAt ??= clock()

      return Promise.resolve({
        id: row.id,
        createdAt: row.createdAt,
        label: row.label,
        revokedAt: row.revokedAt,
      })
    },
  }
}

function route(store: KeyStore, lines: string[] = []) {
  return keysRoute({
    store,
    logger: createLogger({ level: 'debug', sink: (line) => lines.push(line) }),
  })
}

const post = (app: ReturnType<typeof route>, body?: unknown) =>
  app.request(
    '/v1/keys',
    body === undefined
      ? { method: 'POST' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  )

describe('POST /v1/keys', () => {
  it('видає ключ на порожній запит — без тіла й без content-type', async () => {
    const response = await post(route(fakeStore()))

    expect(response.status).toBe(201)

    const issued = issuedKeySchema.parse(await response.json())

    expect(issued.key.startsWith(KEY_PREFIX)).toBe(true)
    expect(issued.id).toBe(ID)
    expect(issued.createdAt).toBe('2026-09-24T12:00:00.000Z')
    expect(issued.label).toBeNull()
  })

  it('зберігає хеш токена, а не сам токен', async () => {
    const store = fakeStore()
    const response = await post(route(store))
    const issued = issuedKeySchema.parse(await response.json())

    expect(store.issued).toHaveLength(1)
    expect(store.issued[0]?.keyHash).toBe(await hashKeyToken(issued.key))
    expect(JSON.stringify(store.issued)).not.toContain(issued.key)
  })

  it('не повторює ключ між видачами', async () => {
    const app = route(fakeStore())
    const first = issuedKeySchema.parse(await (await post(app)).json())
    const second = issuedKeySchema.parse(await (await post(app)).json())

    expect(first.key).not.toBe(second.key)
  })

  it('забороняє кешувати відповідь із секретом', async () => {
    const response = await post(route(fakeStore()))

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('приймає позначку, обрізавши пробіли', async () => {
    const store = fakeStore()
    const response = await post(route(store), { label: '  стенд  ' })

    expect(store.issued[0]?.label).toBe('стенд')
    expect(issuedKeySchema.parse(await response.json()).label).toBe('стенд')
  })

  it.each([
    ['порожню', ''],
    ['довшу за 64 символи', 'я'.repeat(65)],
    ['не рядок', 7],
  ])('відмовляє на позначку %s і нічого не видає', async (_case, label) => {
    const store = fakeStore()
    const response = await post(route(store), { label })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(INVALID_LABEL)
    expect(store.issued).toHaveLength(0)
  })

  it('не пише в лог ні токен, ні текст позначки', async () => {
    const lines: string[] = []
    const response = await post(route(fakeStore(), lines), { label: 'бот арбітражу' })
    const issued = issuedKeySchema.parse(await response.json())
    const log = lines.join('\n')

    expect(log).toContain(ID)
    expect(log).not.toContain(issued.key)
    expect(log).not.toContain('бот арбітражу')
  })

  it('бере випадковість із переданого джерела', async () => {
    const store = fakeStore()
    const app = keysRoute({
      store,
      logger: createLogger({ level: 'fatal', sink: () => {} }),
      random: (size) => new Uint8Array(size).fill(0xab),
    })

    const issued = issuedKeySchema.parse(await (await post(app)).json())

    expect(issued.key).toBe(`${KEY_PREFIX}${'ab'.repeat(32)}`)
  })
})

const REVOKED_AT = new Date('2026-09-25T09:30:00.000Z')

/** Issues a key through the route and hands back what its owner would hold. */
async function issueKey(app: ReturnType<typeof route>, label?: string) {
  const response = await post(app, label === undefined ? undefined : { label })

  return issuedKeySchema.parse(await response.json())
}

const del = (app: ReturnType<typeof route>, id: string, header?: string) =>
  app.request(`/v1/keys/${id}`, {
    method: 'DELETE',
    ...(header === undefined ? {} : { headers: { authorization: header } }),
  })

const bearer = (token: string) => `Bearer ${token}`

describe('DELETE /v1/keys/:id', () => {
  it('switches off the key whose token the caller presents', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app, 'стенд')

    const response = await del(app, issued.id, bearer(issued.key))

    expect(response.status).toBe(200)

    const revoked = revokedKeySchema.parse(await response.json())

    expect(revoked).toEqual({
      id: issued.id,
      createdAt: issued.createdAt,
      revokedAt: REVOKED_AT.toISOString(),
      label: 'стенд',
    })
    expect(store.rows[0]?.revokedAt).toEqual(REVOKED_AT)
  })

  it('looks the key up by the hash of the token, never by the token', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    await del(app, issued.id, bearer(issued.key))

    expect(store.revoked).toEqual([{ id: issued.id, keyHash: await hashKeyToken(issued.key) }])
    expect(JSON.stringify(store.revoked)).not.toContain(issued.key)
  })

  it('repeats without moving the time: a revoked token still names its own key', async () => {
    const later = new Date('2026-09-25T11:00:00.000Z')
    let now = REVOKED_AT
    const store = fakeStore(() => now)
    const app = route(store)
    const issued = await issueKey(app)

    const first = revokedKeySchema.parse(await (await del(app, issued.id, bearer(issued.key))).json())

    now = later

    const second = await del(app, issued.id, bearer(issued.key))

    expect(second.status).toBe(200)
    expect(revokedKeySchema.parse(await second.json()).revokedAt).toBe(first.revokedAt)
    expect(first.revokedAt).toBe(REVOKED_AT.toISOString())
  })

  it('keeps the counters of the key it switches off (FR-048)', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    await store.recordUsage(issued.id, new Date('2026-09-25T08:14:00.000Z'))
    await store.recordUsage(issued.id, new Date('2026-09-25T08:51:00.000Z'))

    const before = new Map(store.usage)

    expect(before.get(`${issued.id}|2026-09-25T08:00:00.000Z`)).toBe(2)

    await del(app, issued.id, bearer(issued.key))

    expect(store.usage).toEqual(before)
  })

  it('refuses without a key and says which scheme it wants', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    const response = await del(app, issued.id)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.json()).toEqual(MISSING_KEY)
    expect(store.revoked).toHaveLength(0)
    expect(store.rows[0]?.revokedAt).toBeNull()
  })

  it.each([
    ['the token without a scheme', (token: string) => token],
    ['another scheme', (token: string) => `Basic ${token}`],
    ['the scheme alone', () => 'Bearer'],
    ['a token of the wrong shape', () => 'Bearer flr_nothexatall'],
    ['a hash instead of a token', () => 'Bearer c229007e38529366cb1ead999ed618db'],
  ])('refuses %s and revokes nothing', async (_case, header) => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    const response = await del(app, issued.id, header(issued.key))

    expect(response.status).toBe(401)
    expect(store.revoked).toHaveLength(0)
    expect(store.rows[0]?.revokedAt).toBeNull()
  })

  it('will not switch off somebody else’s key, and leaves the caller’s own alone', async () => {
    const store = fakeStore()
    const app = route(store)
    const mine = await issueKey(app)
    const theirs = await issueKey(app)

    expect(theirs.id).not.toBe(mine.id)

    const response = await del(app, theirs.id, bearer(mine.key))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(NO_SUCH_KEY)
    expect(store.rows.every((row) => row.revokedAt === null)).toBe(true)
  })

  it('answers the same 404 for a token that was never issued', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    const response = await del(app, issued.id, bearer(`${KEY_PREFIX}${'ab'.repeat(32)}`))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(NO_SUCH_KEY)
    expect(store.rows[0]?.revokedAt).toBeNull()
  })

  it('keeps a path id that is not a uuid away from the database', async () => {
    const store = fakeStore()
    const app = route(store)
    const issued = await issueKey(app)

    const response = await del(app, 'not-a-uuid', bearer(issued.key))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(NO_SUCH_KEY)
    expect(store.revoked).toHaveLength(0)
  })

  it('forbids caching an answer to a request that carried a secret', async () => {
    const app = route(fakeStore())
    const issued = await issueKey(app)

    const response = await del(app, issued.id, bearer(issued.key))

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('logs the id and not the token', async () => {
    const lines: string[] = []
    const store = fakeStore()
    const app = route(store, lines)
    const issued = await issueKey(app, 'бот арбітражу')

    await del(app, issued.id, bearer(issued.key))

    const log = lines.join('\n')

    expect(log).toContain('key revoked')
    expect(log).not.toContain(issued.key)
    expect(log).not.toContain('бот арбітражу')
  })
})

/**
 * The promise of FR-048 — a revoked key keeps its counters — is a property of
 * one SQL statement, and there is no local Postgres to observe it. So the
 * statement is read instead. It guards the statement, not the method: a second
 * `delete` added next to it inside `revoke` would slip past.
 */
describe('revokeStatement', () => {
  const handle = createDatabase('postgres://nobody@127.0.0.1:1/unused')

  afterAll(() => handle.close())

  const query = revokeStatement(handle.db, { id: ID, keyHash: 'c229007e' }).toSQL()

  it('touches api_keys and nothing else', () => {
    expect(query.sql).toContain('"api_keys"')
    expect(query.sql).not.toContain('key_usage')
  })

  it('stamps the time only if it is not stamped yet', () => {
    expect(query.sql).toMatch(/set\s+"revoked_at"\s*=\s*coalesce\(/i)
    expect(query.sql).toContain('now()')
  })

  it('demands both halves of the proof and passes them as parameters', () => {
    expect(query.sql).toContain('"id" = $1')
    expect(query.sql).toContain('"key_hash" = $2')
    expect(query.params).toEqual([ID, 'c229007e'])
  })

  it('returns the record without the hash', () => {
    expect(query.sql).toMatch(/returning/i)
    expect(query.sql).toContain('"revoked_at"')
    expect(query.sql.slice(query.sql.search(/returning/i))).not.toContain('key_hash')
  })
})
