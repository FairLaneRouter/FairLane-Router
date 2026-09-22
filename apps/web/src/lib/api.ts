import { historySchema, type History } from '@fairlane/shared/history'
import { summarySchema, type Summary, type SummaryWindow } from '@fairlane/shared/summary'

/**
 * Схема відповіді приїжджає з `@fairlane/shared`, а не переписана тут, і це
 * свідомий відступ від рішення `lib/method.ts`. Там дублювання виправдане:
 * чотири цілих проти цілого Zod у бандлі. Тут інша величина — контракт із
 * пʼятнадцяти полів, який житиме й змінюватиметься; його розходження з API
 * виглядало б у інтерфейсі як `undefined` замість числа, тобто як порожнє
 * місце, а не як помилка. Підшлях `@fairlane/shared/summary` бере рівно один
 * модуль: клієнт RPC, читання конфігу й логер у браузер не їдуть.
 */
export type { History, Summary, SummaryWindow }

/**
 * Адреса API. У розробці — сусідній процес на 3000; на розгортанні задається
 * `VITE_API_URL` і вшивається в бандл на збірці. Порожнє значення означає той
 * самий домен, що й сторінка, — так виглядає розгортання за одним проксі.
 */
export type BuildEnv = {
  readonly VITE_API_URL?: string | undefined
  readonly DEV?: boolean | undefined
}

export function apiBase(env: BuildEnv = import.meta.env): string {
  const configured = env.VITE_API_URL

  if (configured !== undefined) return configured.replace(/\/+$/, '')

  return env.DEV === true ? 'http://127.0.0.1:3000' : ''
}

export function summaryUrl(base: string, window: SummaryWindow, stream = false): string {
  return `${base}/v1/summary${stream ? '/stream' : ''}?window=${window}`
}

export class ApiError extends Error {
  override readonly name = 'ApiError'
}

/**
 * Відповідь власного API — теж недовірений вхід: між сторінкою і сервером
 * стоять розгортання різних версій, кеші й проксі. Невалідне тіло має бути
 * помилкою, яку видно, а не рядком таблиці з порожніми клітинками.
 */
export function parseSummary(payload: unknown): Summary {
  const parsed = summarySchema.safeParse(payload)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ApiError(`Відповідь API не за контрактом — ${detail}`)
  }

  return parsed.data
}

/**
 * Відповідь, замовлена ще в `index.html` (див. коментар там). Вона одноразова
 * і придатна лише для того вікна, яке замовляли, — інакше сторінка показала б
 * «останню годину» там, де вибрано п'ятнадцять хвилин.
 *
 * Вік обмежений навмисно: сторінка, відкрита у фоновій вкладці і показана за
 * півгодини, не має починати з півгодинних чисел. Прострочену обіцянку просто
 * викидаємо й читаємо наново.
 */
const PRELOAD_MAX_AGE_MS = 30_000

type Preload = {
  readonly window: SummaryWindow
  readonly at: number
  readonly summary: Promise<unknown>
}

export function takePreloadedSummary(
  window: SummaryWindow,
  now: number = Date.now(),
): Promise<unknown> | null {
  const holder = globalThis as { __fairlanePreload?: Preload }
  const preload = holder.__fairlanePreload

  // Одноразова: після першого читання її немає ні для кого, і повторний показ
  // того самого вікна піде звичайним шляхом.
  delete holder.__fairlanePreload

  if (!preload || preload.window !== window) return null
  if (now - preload.at > PRELOAD_MAX_AGE_MS) return null

  return preload.summary
}

export async function fetchSummary(
  window: SummaryWindow,
  options: {
    readonly base?: string
    readonly signal?: AbortSignal
    /** Перекривається тільки в тестах. */
    readonly preloaded?: Promise<unknown> | null
  } = {},
): Promise<Summary> {
  const preloaded = options.preloaded ?? takePreloadedSummary(window)
  if (preloaded) return parseSummary(await preloaded)

  const base = options.base ?? apiBase()
  const response = await fetch(summaryUrl(base, window), {
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    throw new ApiError(`API відповів ${response.status}`)
  }

  return parseSummary(await response.json())
}

export function parseHistory(payload: unknown): History {
  const parsed = historySchema.safeParse(payload)

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new ApiError(`Відповідь API не за контрактом — ${detail}`)
  }

  return parsed.data
}

/** Добова динаміка надлишку (FR-013). Стрічки тут немає навмисно: агрегати
 *  змінюються раз на годину, і підписка чекала б на подію годинами. */
export async function fetchHistory(
  hours: number,
  options: { readonly base?: string; readonly signal?: AbortSignal } = {},
): Promise<History> {
  const base = options.base ?? apiBase()
  const response = await fetch(`${base}/v1/history?hours=${hours}`, {
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) throw new ApiError(`API відповів ${response.status}`)

  return parseHistory(await response.json())
}

export type SummaryStreamHandlers = {
  readonly onSummary: (summary: Summary) => void
  /** Обрив і невалідне тіло приходять сюди однаково — обидва означають «живого немає». */
  readonly onError: (error: unknown) => void
}

/**
 * Підписка на живі оновлення (FR-011). Повертає відписку.
 *
 * `EventSource` перепідключається сам, і саме тому його тут не замінено на
 * `fetch` з читанням потоку: браузер уже вміє відновлювати обірване
 * зʼєднання з витримкою, а нам лишається не заважати. Помилка тому не рве
 * підписку — вона лише знімає позначку «наживо».
 */
export function subscribeSummary(
  window: SummaryWindow,
  handlers: SummaryStreamHandlers,
  base: string = apiBase(),
): () => void {
  const source = new EventSource(summaryUrl(base, window, true))

  source.addEventListener('summary', (event) => {
    try {
      handlers.onSummary(parseSummary(JSON.parse((event as MessageEvent<string>).data)))
    } catch (cause) {
      handlers.onError(cause)
    }
  })

  source.addEventListener('error', (event) => handlers.onError(event))

  return () => source.close()
}
