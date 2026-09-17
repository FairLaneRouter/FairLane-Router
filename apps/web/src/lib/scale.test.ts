import { describe, expect, it } from 'vitest'
import { costDomain, domainTicks, niceBound, tickLabel } from './scale'

describe('niceBound', () => {
  it('snaps to the 1-2-5 scale, not to the decade', () => {
    expect(niceBound(5_690, 'down')).toBe(5_000)
    expect(niceBound(5_690, 'up')).toBe(10_000)
    expect(niceBound(115_000, 'up')).toBe(200_000)
    expect(niceBound(115_000, 'down')).toBe(100_000)
  })

  it('leaves a value that is already round where it is', () => {
    expect(niceBound(20_000, 'down')).toBe(20_000)
    expect(niceBound(20_000, 'up')).toBe(20_000)
  })
})

describe('costDomain', () => {
  // Медіана звичайного RPC — 5 690 лампортів, тобто ліворуч від осі
  // прототипу, яка починалась із 10 000.
  it('covers the real numbers the board shows', () => {
    expect(costDomain([5_001, 5_690, 51_049, 6_000, 10_572, 115_000])).toEqual({
      min: 5_000,
      max: 200_000,
    })
  })

  it('keeps an axis for an empty window instead of collapsing it', () => {
    expect(costDomain([])).toEqual({ min: 1_000, max: 100_000 })
  })

  it('ignores nonsense values rather than stretching the axis to them', () => {
    expect(costDomain([0, -5, Number.NaN, 20_000])).toEqual({ min: 20_000, max: 200_000 })
  })

  // Одне спостереження дало б однакові межі, а з ними логарифм із нульовим
  // знаменником — тобто NaN на кожній координаті.
  it('never returns a domain of zero width', () => {
    const domain = costDomain([10_000])

    expect(domain.max).toBeGreaterThan(domain.min)
  })
})

describe('domainTicks', () => {
  it('marks the 1-2-5 steps inside the range, borders included', () => {
    expect(domainTicks({ min: 5_000, max: 200_000 })).toEqual([
      5_000, 10_000, 20_000, 50_000, 100_000, 200_000,
    ])
  })

  it('labels below a thousand without pretending they are thousands', () => {
    expect(tickLabel(500)).toBe('500')
    expect(tickLabel(5_000)).toBe('5k')
    expect(tickLabel(2_000_000)).toBe('2M')
  })
})
