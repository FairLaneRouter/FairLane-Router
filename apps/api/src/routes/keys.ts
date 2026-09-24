import { apiKeys, keyUsage, type Database } from '@fairlane/db'
import {
  generateKeyToken,
  hashKeyToken,
  issueKeyRequestSchema,
  startOfHour,
  type IssuedKey,
  type Logger,
  type RandomBytes,
} from '@fairlane/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'

/** Рядок `api_keys` у тому вигляді, у якому його бачить маршрут. Хеша тут немає. */
export type KeyRecord = {
  readonly id: string
  readonly createdAt: Date
  readonly label: string | null
}

export type KeyStore = {
  /** Записує **хеш** і повертає видані ідентифікатори. Токен сюди не доходить. */
  issue(input: { readonly keyHash: string; readonly label: string | null }): Promise<KeyRecord>
  /** +1 до лічильника звернень ключа за годину (FR-046). */
  recordUsage(keyId: string, at: Date): Promise<void>
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

  return app
}
