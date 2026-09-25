import { apiKeys, keyUsage, type Database } from '@fairlane/db'
import {
  generateKeyToken,
  hashKeyToken,
  issueKeyRequestSchema,
  readBearerToken,
  startOfHour,
  type IssuedKey,
  type Logger,
  type RandomBytes,
  type RevokedKey,
} from '@fairlane/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

/** Рядок `api_keys` у тому вигляді, у якому його бачить маршрут. Хеша тут немає. */
export type KeyRecord = {
  readonly id: string
  readonly createdAt: Date
  readonly label: string | null
}

/** A key that has been switched off. `revokedAt` is never null here. */
export type RevokedRecord = KeyRecord & { readonly revokedAt: Date }

/**
 * Both halves of the proof of ownership. The id names the key, the hash proves
 * the caller holds its token, and the database checks the pair in one
 * statement — there is nothing to compare in the process, so there is no
 * window in which the pair could be checked against one row and applied to
 * another.
 */
export type RevokeInput = { readonly id: string; readonly keyHash: string }

export type KeyStore = {
  /** Записує **хеш** і повертає видані ідентифікатори. Токен сюди не доходить. */
  issue(input: { readonly keyHash: string; readonly label: string | null }): Promise<KeyRecord>
  /** +1 до лічильника звернень ключа за годину (FR-046). */
  recordUsage(keyId: string, at: Date): Promise<void>
  /** Switches a key off, keeping its counters (FR-048). `undefined` — no such pair. */
  revoke(input: RevokeInput): Promise<RevokedRecord | undefined>
}

/**
 * The statement of revocation, exported for one reason: a test reads its SQL
 * and asserts that it names `api_keys` and never `key_usage`. FR-048 keeps the
 * counters of a revoked key until the aggregates expire on their own, and that
 * promise lives entirely in the text of this statement — there is no local
 * Postgres on the build machine to catch a `delete` that creeps in later.
 *
 * `coalesce(revoked_at, now())` is what makes the call idempotent without a
 * preceding read: the first call stamps the time, every repeat keeps the
 * stamp, and two simultaneous calls cannot disagree about which one won.
 */
export function revokeStatement(db: Database, input: RevokeInput) {
  return db
    .update(apiKeys)
    .set({ revokedAt: sql`coalesce(${apiKeys.revokedAt}, now())` })
    .where(and(eq(apiKeys.id, input.id), eq(apiKeys.keyHash, input.keyHash)))
    .returning({
      id: apiKeys.id,
      createdAt: apiKeys.createdAt,
      label: apiKeys.label,
      revokedAt: apiKeys.revokedAt,
    })
}

/**
 * Сховище ключів.
 *
 * `issue` — один `INSERT` з одним рядком, і це головне, що робить SC-012
 * (видача менш ніж за 10 секунд) не вимогою, а наслідком: перевіряти нема
 * чого, листів не шлють, підтверджувати нічого.
 *
 * `recordUsage` пише в `key_usage` погодинною сіткою `startOfHour` — тією
 * самою, що й згортка посадок. Рядок на ключ на годину означає, що облік
 * росте від **часу**, а не від навантаження: тисяча звернень за годину — це
 * одне оновлення рядка, а не тисяча рядків.
 *
 * Свого виклику `recordUsage` чекає до T040: рахувати звернення має той, хто
 * їх і пропускає, — обмежувач частоти. Тут він живе тому, що це та сама
 * таблиця й та сама домовленість про сітку, і розводити їх по двох модулях
 * означало б дати лічильникам розійтися.
 */
export function createKeyStore(db: Database): KeyStore {
  return {
    async issue(input) {
      const rows = await db
        .insert(apiKeys)
        .values({ keyHash: input.keyHash, label: input.label })
        .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt, label: apiKeys.label })

      const row = rows[0]
      if (row === undefined) throw new Error('база не повернула виданий ключ')

      return row
    },

    async recordUsage(keyId, at) {
      await db
        .insert(keyUsage)
        .values({ keyId, hour: startOfHour(at), requests: 1 })
        .onConflictDoUpdate({
          target: [keyUsage.keyId, keyUsage.hour],
          // Приріст рахує Postgres у самому рядку: прочитати, додати й
          // записати з процесу означало б втрачати звернення на кожному
          // збігу двох запитів у ту саму годину.
          set: { requests: sql`${keyUsage.requests} + 1` },
        })
    },

    async revoke(input) {
      const rows = await revokeStatement(db, input)
      const row = rows[0]
      if (row === undefined) return undefined

      // The column is nullable in the schema, and the statement above is the
      // reason it cannot be null here; the guard is for the day somebody
      // rewrites the statement without `coalesce`.
      const { revokedAt } = row
      if (revokedAt === null) throw new Error('база відкликала ключ без часу відкликання')

      return { id: row.id, createdAt: row.createdAt, label: row.label, revokedAt }
    },
  }
}

/** Тіло відмови, коли позначка не проходить за формою. */
export const INVALID_LABEL = {
  error: {
    code: 'INVALID_INPUT',
    message: 'The key label must be a string of 1 to 64 characters',
    details: { field: 'label' },
  },
} as const

/** The refusal when no key was presented — or what was presented is not one. */
export const MISSING_KEY = {
  error: {
    code: 'UNAUTHENTICATED',
    message: 'Present the key itself: Authorization: Bearer <key>',
    details: {},
  },
} as const

/**
 * The refusal when the pair of key and id opens nothing.
 *
 * One body for three different reasons — no such key, somebody else's key, the
 * wrong id — and that is deliberate: distinct answers would turn the route
 * into an oracle that tells, by status code alone, which tokens exist.
 */
export const NO_SUCH_KEY = {
  error: { code: 'NOT_FOUND', message: 'No such key', details: {} },
} as const

export type KeysRouteOptions = {
  readonly store: KeyStore
  readonly logger: Logger
  /** Перекривається тільки в тестах. */
  readonly random?: RandomBytes
}

/**
 * `POST /v1/keys` — самообслуговувана видача ключа (FR-021, FR-046, SC-012).
 *
 * Пошти, пароля й підтвердження немає за побудовою: єдине поле запиту —
 * необов'язкова позначка, і навіть вона потрібна лише власникові ключа, щоб
 * потім упізнати свій рядок. Порожнє тіло — повноцінний запит.
 *
 * Токен повертається **один раз**: у базі лежить його SHA-256, і відновити
 * загублений ключ нізвідки. Це не суворість заради суворості — саме воно
 * робить витік бази не витоком ключів.
 *
 * Ліміту частоти на самій видачі тут немає: він з'являється в T040 разом з
 * усіма іншими маршрутами. До того часу маршрут дозволяє намолотити скільки
 * завгодно рядків `api_keys`, і це відома дірка, а не недогляд.
 */
export function keysRoute(options: KeysRouteOptions): Hono {
  const { store, logger } = options
  const random = options.random
  const app = new Hono()

  app.post('/v1/keys', async (c) => {
    // Порожнє тіло й тіло без `content-type` — звичайний спосіб покликати цей
    // маршрут (`curl -X POST …`), тому розбір, що не вдався, тут означає
    // «полів не передали», а не помилку.
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = issueKeyRequestSchema.safeParse(body)
    if (!parsed.success) return c.json(INVALID_LABEL, 400)

    const token = random === undefined ? generateKeyToken() : generateKeyToken(random)
    const record = await store.issue({
      keyHash: await hashKeyToken(token),
      label: parsed.data.label ?? null,
    })

    // У лог іде ідентифікатор і сам факт позначки — ніколи токен і ніколи
    // текст позначки. Лог на Render читає більше людей, ніж базу.
    logger.info('ключ видано', { id: record.id, labelled: record.label !== null })

    const issued: IssuedKey = {
      id: record.id,
      key: token,
      createdAt: record.createdAt.toISOString(),
      label: record.label,
    }

    // Відповідь містить секрет: ні кеш посередника, ні кеш браузера не мають
    // права її лишити в себе.
    c.header('Cache-Control', 'no-store')

    return c.json(issued, 201)
  })

  /**
   * `DELETE /v1/keys/:id` — the owner switches their own key off (FR-048).
   *
   * There are no accounts in the product, so there is no session to check and
   * nobody to ask. The proof of ownership is the key itself: the caller sends
   * it in `Authorization: Bearer <key>`, and the id in the path must be the id
   * of that very key. Either half alone would be wrong in a different way —
   * the id alone lets a stranger switch off a key they merely saw in a log,
   * the token alone makes `DELETE /v1/keys/<anything>` quietly revoke whatever
   * the caller happens to hold.
   *
   * The counters stay (FR-048): revocation writes one column of `api_keys`,
   * and `key_usage` is not named in the statement at all. Billing an
   * integrator for the hours they did use must not depend on their not having
   * pressed this button.
   *
   * Nothing here refuses an already revoked key. A revoked token no longer
   * **serves** requests — that guard belongs to T040, on the reading path —
   * but it still **names** its own row, for good: the hash does not change,
   * and if it stopped identifying the key, a repeated `DELETE` would answer
   * 401 and the caller could never learn that the first one worked.
   */
  app.delete('/v1/keys/:id', async (c) => {
    const token = readBearerToken(c.req.header('authorization'))

    if (token === undefined) {
      // The scheme goes back on a 401, as a client is entitled to expect;
      // no realm, because there is nothing here to log into.
      c.header('WWW-Authenticate', 'Bearer')

      return c.json(MISSING_KEY, 401)
    }

    // An id that is not a UUID cannot name a key of ours, and saying so with
    // 400 would only mean the same thing in a second voice. It is also what
    // keeps a malformed path out of the database: `uuid = 'x'` is an error
    // there, not an empty result, and it would surface as 500.
    const id = z.uuid().safeParse(c.req.param('id'))
    if (!id.success) return c.json(NO_SUCH_KEY, 404)

    const record = await store.revoke({ id: id.data, keyHash: await hashKeyToken(token) })
    if (record === undefined) return c.json(NO_SUCH_KEY, 404)

    // The id and nothing else: the token reached this line, and a log line is
    // read by more people than the database is.
    logger.info('key revoked', { id: record.id })

    const revoked: RevokedKey = {
      id: record.id,
      createdAt: record.createdAt.toISOString(),
      revokedAt: record.revokedAt.toISOString(),
      label: record.label,
    }

    // The answer carries no secret, but the request did, and a shared cache
    // keyed without the header would hand this body to the next caller.
    c.header('Cache-Control', 'no-store')

    return c.json(revoked, 200)
  })

  return app
}
