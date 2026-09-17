/** Logarithmic position helper used by every hand-drawn chart. */
export const logPos = (
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): number => {
  const a = Math.log10(domainMin)
  const b = Math.log10(domainMax)
  const t = (Math.log10(value) - a) / (b - a)
  return rangeMin + t * (rangeMax - rangeMin)
}

export const linPos = (
  value: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): number => rangeMin + (value / domainMax) * (rangeMax - rangeMin)

/** Axis ticks for the cost axis, in lamports. */
export const COST_TICKS = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000]

export const tickLabel = (v: number): string => {
  if (v >= 1_000_000) return `${v / 1_000_000}M`
  if (v >= 1_000) return `${v / 1_000}k`

  return String(v)
}

export const AXIS_MIN = 10_000
export const AXIS_MAX = 2_000_000

const STEPS = [1, 2, 5] as const

/**
 * Найближче «кругле» значення шкали 1-2-5. Не десятка: між 10k і 100k лежить
 * уся різниця між звичайним RPC і сервісом доставки, і округлення до декади
 * зіпхнуло б їх в одну точку.
 */
export function niceBound(value: number, direction: 'down' | 'up'): number {
  if (!(value > 0)) return 1

  const decade = 10 ** Math.floor(Math.log10(value))
  const candidates = [...STEPS.map((step) => step * decade), 10 * decade]

  return direction === 'down'
    ? (candidates.filter((c) => c <= value).at(-1) ?? decade)
    : (candidates.find((c) => c >= value) ?? 10 * decade)
}

export type Domain = {
  readonly min: number
  readonly max: number
}

/**
 * Межі осі з самих даних. Прототип малював фіксовані 10k…2M, і на живих
 * числах це перша ж помилка: медіана звичайного RPC — 5 690 лампортів, тобто
 * ліворуч від початку осі. Порожня вибірка лишає діапазон за замовчуванням —
 * вісь усе одно має бути намальована, щоб було видно, де саме нічого немає.
 */
export function costDomain(values: readonly number[]): Domain {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0)
  if (positive.length === 0) return { min: 1_000, max: 100_000 }

  const min = niceBound(Math.min(...positive), 'down')
  const max = niceBound(Math.max(...positive), 'up')

  // Однакові межі дають логарифм із нульовим знаменником — на одному
  // спостереженні це не рідкість, а норма.
  return min === max ? { min, max: max * 10 } : { min, max }
}

/** Позначки 1-2-5 усередині діапазону, включно з його межами. */
export function domainTicks(domain: Domain): number[] {
  const ticks: number[] = []

  for (let decade = 10 ** Math.floor(Math.log10(domain.min)); decade <= domain.max; decade *= 10) {
    for (const step of STEPS) {
      const tick = step * decade
      if (tick >= domain.min && tick <= domain.max) ticks.push(tick)
    }
  }

  return ticks
}
