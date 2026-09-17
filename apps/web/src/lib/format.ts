/**
 * Формати живого дашборду. Окремо від `lib/mock.ts` навмисно: після T033
 * дашборд не має права імпортувати нічого з мок-модуля, інакше синтетичне
 * число одного дня знову опиниться поруч зі справжнім і буде від нього
 * невідрізненне.
 */

const INTEGER = new Intl.NumberFormat('en-US')

export const fmtInt = (value: number): string => INTEGER.format(value)

/** Лампорти. Знак зберігається: надлишок буває відʼємним. */
export const fmtLamports = (value: number | null): string =>
  value === null ? '—' : INTEGER.format(value)

export const fmtShare = (share: number | null): string =>
  share === null ? '—' : `${(share * 100).toFixed(1)}%`

/**
 * Вік даних словами. Секунди до хвилини, далі хвилини, далі години: точність
 * до секунди на годинному відставанні нічого не додає, а місця займає більше
 * за саме число.
 */
export function fmtAge(ms: number | null): string {
  if (ms === null) return 'no data'
  if (ms < 1000) return 'just now'

  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  return `${Math.round(minutes / 60)} h ago`
}

export const WINDOW_LABELS = {
  '15m': 'last 15 minutes',
  '1h': 'last hour',
  '24h': 'last 24 hours',
} as const
