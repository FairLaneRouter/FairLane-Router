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

export const tickLabel = (v: number): string =>
  v >= 1_000_000 ? `${v / 1_000_000}M` : `${v / 1_000}k`

export const AXIS_MIN = 10_000
export const AXIS_MAX = 2_000_000
