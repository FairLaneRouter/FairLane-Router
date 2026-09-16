import type { Logger, Summary, SummaryWindow } from '@fairlane/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  chooseWindow,
  INVALID_WINDOW,
  type SummaryProvider,
  type Watermark,
} from './summary.ts'

/**
 * Як часто питати сховище, чи щось змінилось. Індексатор кладе слот приблизно
 * раз на 40 секунд (крок вибірки 100), тож п'ять секунд дають затримку,
 * непомітну на тлі самої вибірки, і не роблять із опитування навантаження:
 * запит — зворотне індексне читання по `created_at`, три буфери.
 *
 * Опитування, а не `LISTEN/NOTIFY`, і це вимушено: зʼєднання йде через
 * pgbouncer у режимі транзакцій, а він сеансових підписок не проводить
 * (`packages/db/src/client.ts`). Тримати заради стрічки друге, пряме
 * зʼєднання означало б платити постійним сеансом за подію раз на 40 секунд.
 */
export const WATERMARK_INTERVAL_MS = 5_000

/**
 * Порожній коментар SSE раз на цей строк. Посередники і балансувальники
 * рвуть зʼєднання, у якому нічого не йде, а між слотами вибірки мовчання
 * триває довше за їхні звичайні 30 секунд.
 */
export const PING_INTERVAL_MS = 20_000

export type SummaryListener = (summary: Summary) => void

export type SummaryHub = {
  /** Повертає відписку. Останній, хто пішов, гасить опитування. */
  subscribe(window: SummaryWindow, listener: SummaryListener): () => void
  readonly size: number
  close(): void
}

export type SummaryHubOptions = {
  readonly provider: SummaryProvider
  readonly watermark: () => Promise<Watermark>
  readonly logger: Logger
  readonly intervalMs?: number
}

type Subscription = {
  readonly window: SummaryWindow
  readonly listener: SummaryListener
}

function markOf(watermark: Watermark): string {
  return `${watermark.slot ?? '-'}|${watermark.writtenAt?.getTime() ?? '-'}`
}

/**
 * Одне опитування сховища на весь застосунок і один перерахунок на вікно
 * (FR-011). Це головне рішення модуля: без спільного вузла кожен підписник
 * тягнув би власний таймер і власний запит, і сотня відкритих вкладок
 * дашборду перетворилась би на сотню однакових запитів до безкоштовного
 * тарифу — рівно тоді, коли продукт починає комусь бути потрібним.
 *
 * Опитування живе, лише поки є кому слухати. Порожній вузол не тримає ані
 * таймера, ані зʼєднання.
 */
export function createSummaryHub(options: SummaryHubOptions): SummaryHub {
  const { provider, watermark, logger } = options
  const intervalMs = options.intervalMs ?? WATERMARK_INTERVAL_MS
  const subscriptions = new Set<Subscription>()

  let timer: ReturnType<typeof setInterval> | null = null
  let mark: string | null = null
  let busy = false

  async function broadcast(): Promise<void> {
    const windows = new Set([...subscriptions].map((subscription) => subscription.window))

    for (const window of windows) {
      let summary: Summary
      try {
        summary = await provider.refresh(window)
      } catch (cause) {
        // Несправність сховища не має рвати стрічку: підписник лишається на
        // місці й отримає наступну подію, коли база відповість.
        logger.error('зведення для стрічки не перераховано', { err: cause, window })
        continue
      }

      for (const subscription of subscriptions) {
        if (subscription.window !== window) continue
        try {
          subscription.listener(summary)
        } catch (cause) {
          // Обірваний сокет одного підписника не стосується решти.
          logger.warn('подію не доставлено', { err: cause, window })
        }
      }
    }
  }

  async function tick(): Promise<void> {
    // Тік, що не встиг завершитись, не має накладатись на наступний: обидва
    // читали б однаковий обрій і перераховували б те саме двічі.
    if (busy) return
    busy = true

    try {
      const current = markOf(await watermark())
      if (current === mark) return

      // Перший тік лише знімає відлік. Інакше кожен підписник отримував би
      // одразу після підключення другу подію з тими самими числами: першу
      // маршрут уже надіслав сам.
      const first = mark === null
      mark = current
      if (!first) await broadcast()
    } catch (cause) {
      logger.error('обрій сховища не прочитано', { err: cause })
    } finally {
      busy = false
    }
  }

  return {
    get size() {
      return subscriptions.size
    },

    subscribe(window, listener) {
      const subscription: Subscription = { window, listener }
      subscriptions.add(subscription)

      if (timer === null) {
        mark = null
        timer = setInterval(() => void tick(), intervalMs)
        // Довгоживучий таймер не має тримати процес: коли працювати більше
        // нема з чим, індексатор і API мають виходити самі.
        timer.unref?.()
        void tick()
      }

      return () => {
        subscriptions.delete(subscription)
        if (subscriptions.size > 0 || timer === null) return

        clearInterval(timer)
        timer = null
      }
    },

    close() {
      subscriptions.clear()
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}

export type StreamRouteOptions = {
  readonly provider: SummaryProvider
  readonly hub: SummaryHub
  readonly logger: Logger
  readonly pingIntervalMs?: number
}

/**
 * `GET /v1/summary/stream` — те саме зведення подією `summary` на кожен новий
 * оброблений слот (FR-011). Ключа не потребує, як і сам маршрут зведення
 * (FR-049).
 *
 * Перша подія йде **одразу після підключення**, а не з першою зміною у
 * сховищі. Інакше сторінка, відкрита між слотами вибірки, показувала б
 * порожнечу до сорока секунд — і чекала б тим довше, чим рідше ми читаємо
 * ланцюг.
 */
export function streamRoute(options: StreamRouteOptions): Hono {
  const { provider, hub, logger } = options
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS
  const app = new Hono()

  app.get('/v1/summary/stream', (c) => {
    const choice = chooseWindow(c.req.query('window'))
    if (!choice.ok) return c.json(INVALID_WINDOW, 400)

    const { window } = choice

    // Проксі, які буферизують відповідь, перетворюють стрічку на дуже повільне
    // завантаження файлу. Заголовок вимикає буферизацію в nginx і сумісних.
    c.header('X-Accel-Buffering', 'no')

    return streamSSE(c, async (stream) => {
      const send = (summary: Summary) =>
        stream.writeSSE({ event: 'summary', data: JSON.stringify(summary) })

      await send(await provider.get(window))

      const ping = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' })
      }, pingIntervalMs)
      ping.unref?.()

      /**
       * Відключення приходить двома різними шляхами, і жоден не покриває
       * обох середовищ. `streamSSE` кличе `onAbort` тоді, коли скасовано
       * читання відповіді, а на сигнал самого запиту підписується лише під
       * старим Bun (`hono/helper/streaming/sse`). Адаптер Node, навпаки,
       * зводить обрив зʼєднання саме до сигналу запиту. Підписка на обидва
       * коштує три рядки, а її відсутність — по одному вічному підписнику на
       * кожну закриту вкладку.
       */
      const closed = new Promise<void>((resolve) => {
        stream.onAbort(resolve)

        const signal = c.req.raw.signal
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })

      const unsubscribe = hub.subscribe(window, (summary) => {
        // Запис у мертвий сокет відхиляє обіцянку, а не кидає синхронно:
        // без цього перехоплення падіння одного підписника стало б
        // необробленою відмовою в процесі.
        void send(summary).catch((cause: unknown) => {
          logger.debug('стрічку обірвано на записі', { err: cause, window })
        })
      })

      logger.debug('підписник приєднався', { window, subscribers: hub.size })

      try {
        await closed
      } finally {
        clearInterval(ping)
        unsubscribe()
        logger.debug('підписник відключився', { window, subscribers: hub.size })
      }
    })
  })

  return app
}
