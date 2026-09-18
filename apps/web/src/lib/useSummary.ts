import { useEffect, useState } from 'react'
import {
  fetchHistory,
  fetchSummary,
  subscribeSummary,
  type History,
  type Summary,
  type SummaryWindow,
} from './api'

export type SummaryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly summary: Summary; readonly live: boolean }

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message

  return 'Не вдалося звʼязатися з API'
}

/**
 * Зведення за вікном: один запит одразу і жива стрічка поверх нього (FR-011).
 *
 * Два джерела, а не одне, і це не дублювання. Стрічка перепідключається сама,
 * але між обривом і відновленням вона мовчить, а перший її запит однаково
 * повертає поточний стан — тобто окремого читання вистачило б лише доти, доки
 * зʼєднання жодного разу не впало. Навпаки, самої стрічки замало для першого
 * екрана: `EventSource` не має способу повідомити «підключення не вдалося,
 * більше не чекай», і сторінка застрягла б у стані завантаження.
 *
 * Обрив стрічки не стирає чисел: `live` стає `false`, дані лишаються
 * останніми відомими, а їхній вік видно на екрані окремо (FR-015).
 */
export function useSummary(window: SummaryWindow): SummaryState {
  const [state, setState] = useState<SummaryState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true

    setState({ status: 'loading' })

    fetchSummary(window, { signal: controller.signal })
      .then((summary) => {
        if (alive) setState({ status: 'ready', summary, live: true })
      })
      .catch((cause: unknown) => {
        if (alive && !controller.signal.aborted) {
          setState({ status: 'error', message: describe(cause) })
        }
      })

    const unsubscribe = subscribeSummary(window, {
      onSummary: (summary) => {
        if (alive) setState({ status: 'ready', summary, live: true })
      },
      onError: () => {
        if (!alive) return
        // Помилка стрічки не переводить сторінку в стан помилки: числа, які
        // вже показані, лишаються правдою про свій момент, і сказати про це
        // чесніше, ніж стерти таблицю.
        setState((current) =>
          current.status === 'ready' ? { ...current, live: false } : current,
        )
      },
    })

    return () => {
      alive = false
      controller.abort()
      unsubscribe()
    }
  }, [window])

  return state
}

export type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly history: History }

/**
 * Добова динаміка (FR-013). Читається один раз на відкриття і оновлюється
 * разом зі зміною `revision` — тобто коли зведення принесло новий слот.
 * Підписки тут немає навмисно: рядок агрегату зʼявляється раз на годину, і
 * тримати відкрите зʼєднання заради події, якої годину не буде, немає за що.
 */
export function useHistory(hours: number, revision: number): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: 'loading' })

  // `revision` навмисно не використовується всередині ефекту: це лічильник,
  // сама зміна якого й означає «пора перечитати». Прибрати його з залежностей
  // означає лишити графік на числах тієї години, в яку відкрили сторінку.
  // biome-ignore lint/correctness/useExhaustiveDependencies: лічильник перечитування, див. вище
  useEffect(() => {
    const controller = new AbortController()
    let alive = true

    fetchHistory(hours, { signal: controller.signal })
      .then((history) => {
        if (alive) setState({ status: 'ready', history })
      })
      .catch((cause: unknown) => {
        if (alive && !controller.signal.aborted) {
          setState({ status: 'error', message: describe(cause) })
        }
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [hours, revision])

  return state
}
