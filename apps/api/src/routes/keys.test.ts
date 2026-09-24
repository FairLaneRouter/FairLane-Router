import { createLogger, hashKeyToken, issuedKeySchema, KEY_PREFIX } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import { INVALID_LABEL, keysRoute, type KeyRecord, type KeyStore } from './keys.ts'

const CREATED_AT = new Date('2026-09-24T12:00:00.000Z')
const ID = '6f1c0d2e-9a3b-4c5d-8e7f-0a1b2c3d4e5f'

type Issued = { readonly keyHash: string; readonly label: string | null }

type FakeStore = KeyStore & { readonly issued: Issued[] }

function fakeStore(): FakeStore {
  const issued: Issued[] = []

  return {
    issued,
    issue: (input) => {
      issued.push(input)

      const record: KeyRecord = { id: ID, createdAt: CREATED_AT, label: input.label }

      return Promise.resolve(record)
    },
    recordUsage: () => Promise.resolve(),
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
