import { z } from 'zod'

/**
 * Ключі доступу (FR-021, FR-046).
 *
 * Обліковий запис у продукті відсутній за рішенням спеки: ключ видається
 * самообслуговуванням, без пошти, пароля й будь-яких персональних даних. Тому
 * весь «вхід» — це порівняння двох хешів, і бібліотеці автентифікації тут не
 * було б чого робити.
 */

/** Префікс у самому токені. Видно в логах і чужому коді, чий це ключ і що це не адреса. */
export const KEY_PREFIX = 'flr_'

/** 256 біт випадковості. Менше — і токен стає вгадуваним перебором на нашому ж ліміті. */
export const KEY_BYTES = 32

/**
 * Шістнадцятковий запис, а не base58 і не base64url. Токен нікому не
 * диктують голосом, зате його розбирає і людина, і `grep`, і регулярний
 * вираз на межі: один алфавіт, один регістр, фіксована довжина. Base58 тут
 * зекономив би десяток символів ціною власного кодувальника — у `base58.ts`
 * є лише декодер, бо більше нічому не було потрібно.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Довжина токена цілком: префікс плюс два символи на байт. */
export const KEY_TOKEN_LENGTH = KEY_PREFIX.length + KEY_BYTES * 2

const keyTokenPattern = new RegExp(`^${KEY_PREFIX}[0-9a-f]{${KEY_BYTES * 2}}$`)

/**
 * Форма токена. Схема потрібна не для безпеки — невірний токен однаково не
 * знайдеться за хешем, — а щоб відрізнити «ключ не той» від «це взагалі не
 * ключ» і сказати про це різними відповідями (T040).
 */
export const keyTokenSchema = z.string().regex(keyTokenPattern)

export type RandomBytes = (size: number) => Uint8Array

/**
 * Джерело випадковості — глобальний `crypto`, а не `node:crypto`. Обидва
 * дають ту саму CSPRNG, але глобальний не тягне імпорт платформи в пакет,
 * який збирається і для браузера: `packages/shared` імпортує `apps/web`.
 */
const systemRandom: RandomBytes = (size) => crypto.getRandomValues(new Uint8Array(size))

/**
 * Новий токен. Джерело випадковості приходить параметром лише заради тестів:
 * у продукті підмінювати його немає навіщо, і дефолт саме тому системний.
 */
export function generateKeyToken(random: RandomBytes = systemRandom): string {
  return KEY_PREFIX + toHex(random(KEY_BYTES))
}

/**
 * SHA-256 від токена цілком, шістнадцятковим рядком. У базі лежить **тільки**
 * це значення (FR-046).
 *
 * Повільної функції (bcrypt, argon2) тут немає свідомо, і це не економія:
 * вони захищають **вгадуваний** секрет — пароль, який людина вигадала. Тут
 * секрет має 256 біт випадковості, і перебір по хешу не швидший за перебір
 * самого токена. Ціна повільної функції — затримка на кожному зверненні з
 * ключем, тобто на гарячому шляху рекомендації (SC-004, < 300 мс).
 */
export async function hashKeyToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))

  return toHex(new Uint8Array(digest))
}

/**
 * Позначка ключа — довільний рядок власника («бот арбітражу», «стенд»).
 * Необов'язкова і ні на що не впливає: вимога «без персональних даних»
 * (FR-021) забороняє **питати** їх, а не вписувати щось у вільне поле, тому
 * сюди нічого не підставляється й нічого не виводиться назовні.
 */
export const keyLabelSchema = z.string().trim().min(1).max(64)

/**
 * Тіло запиту на видачу. Порожнє тіло — теж запит: ключ видається без жодного
 * поля, і це найкоротший шлях, який вимірює SC-012.
 */
export const issueKeyRequestSchema = z.object({
  label: keyLabelSchema.optional(),
})

export type IssueKeyRequest = z.infer<typeof issueKeyRequestSchema>

/**
 * Відповідь на видачу. `key` приходить **один раз і більше ніколи** — у базі
 * його немає, відновити нізвідки. Схема живе в `shared`, бо її читатиме SDK
 * (T047), і переписана копія розійшлася б з видачею мовчки.
 */
export const issuedKeySchema = z.object({
  id: z.uuid(),
  key: keyTokenSchema,
  createdAt: z.iso.datetime(),
  label: keyLabelSchema.nullable(),
})

export type IssuedKey = z.infer<typeof issuedKeySchema>

/**
 * The scheme of the `Authorization` header, read leniently and matched
 * case-insensitively: RFC 7235 declares the scheme name case-insensitive, and
 * a client that sends `bearer` is not making a mistake worth a 401.
 *
 * The token itself is matched strictly against `keyTokenSchema`, so this
 * function answers one question — "did the caller present something shaped
 * like a key of ours?" — and never "is that key real". The second question
 * has an answer only in the database.
 */
const bearerPattern = /^bearer[ \t]+(\S+)[ \t]*$/i

export function readBearerToken(header: string | null | undefined): string | undefined {
  const match = bearerPattern.exec(header ?? '')
  const token = match?.[1]
  if (token === undefined) return undefined

  const parsed = keyTokenSchema.safeParse(token)

  return parsed.success ? parsed.data : undefined
}

/**
 * The answer to a revocation (FR-048).
 *
 * There is no `key` field, and that is the point: the token is not reprinted
 * on the way out, not even the one the caller has just sent. What the owner
 * gets instead is `revokedAt` — the only evidence that the key is off, and on
 * a repeated call the **original** timestamp rather than a fresh one.
 */
export const revokedKeySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime(),
  label: keyLabelSchema.nullable(),
})

export type RevokedKey = z.infer<typeof revokedKeySchema>
