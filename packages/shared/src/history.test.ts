import { describe, expect, it } from 'vitest'
import { buildChannelRegistry } from './channels.ts'
import { DEFAULT_REGISTRY } from './channels.data.ts'
import {
  buildHistory,
  historyHoursSchema,
  historyRange,
  historySchema,
  MAX_HISTORY_HOURS,
  type HourlyPoint,
} from './history.ts'
import { HOUR_MS } from './time.ts'

const NOW = new Date('2026-08-28T18:34:00.000Z')
const HOUR_17 = new Date('2026-08-28T17:00:00.000Z')
const HOUR_16 = new Date('2026-08-28T16:00:00.000Z')
const HOUR_14 = new Date('2026-08-28T14:00:00.000Z')

const registry = buildChannelRegistry(DEFAULT_REGISTRY)

function point(overrides: Partial<HourlyPoint> = {}): HourlyPoint {
  return {
    groupId: 'jito',
    hour: HOUR_17,
    landings: 4635,
    observations: 4635,
    costP50: 11_260n,
    overpayP50: 6_260n,
    share: 0.1096,
    ...overrides,
  }
}

function build(points: readonly HourlyPoint[], hours = 24) {
  return buildHistory({
    groups: registry.groups,
    points,
    range: historyRange(NOW, hours),
    hours,
    now: NOW,
  })
}

describe('historyHoursSchema', () => {
  it('defaults to the day FR-013 asks for', () => {
    expect(historyHoursSchema.parse(undefined)).toBe(24)
    expect(historyHoursSchema.parse('6')).toBe(6)
  })

  // За строком зберігання агрегатів рядків не існує, і мовчазна порожнеча
  // читалась би як «нічого не було», а не як «ми цього не памʼятаємо».
  it('refuses a range longer than the aggregates are kept', () => {
    expect(historyHoursSchema.safeParse(MAX_HISTORY_HOURS + 1).success).toBe(false)
    expect(historyHoursSchema.safeParse(0).success).toBe(false)
  })
})

describe('historyRange', () => {
  // Згортка пише лише завершені години: намальована як нуль, поточна щогодини
  // показувала б падіння надлишку в підлогу, якого не було.
  it('ends at the start of the current hour, leaving it out', () => {
    const range = historyRange(NOW, 24)

    expect(range.to.toISOString()).toBe('2026-08-28T18:00:00.000Z')
    expect(range.from.toISOString()).toBe('2026-08-27T18:00:00.000Z')
  })

  it('spans exactly the hours asked for', () => {
    const range = historyRange(NOW, 6)

    expect(range.to.getTime() - range.from.getTime()).toBe(6 * HOUR_MS)
  })
})

describe('buildHistory', () => {
  it('produces a payload its own schema accepts', () => {
    expect(historySchema.safeParse(build([point()])).success).toBe(true)
  })

  it('carries the group identity from the registry, not from the row', () => {
    const series = build([point()]).series[0]

    expect(series).toMatchObject({ groupId: 'jito', name: 'Jito', isSendable: false })
  })

  // Нуль означав би «надлишку не було», а насправді означає «ми не дивились».
  it('leaves an hour without a row out of the series instead of drawing a zero', () => {
    const series = build([point({ hour: HOUR_14 }), point({ hour: HOUR_17 })]).series[0]

    expect(series?.points.map((p) => p.hour)).toEqual([
      HOUR_14.toISOString(),
      HOUR_17.toISOString(),
    ])
  })

  it('orders points from the oldest hour to the newest', () => {
    const series = build([point({ hour: HOUR_17 }), point({ hour: HOUR_16 })]).series[0]

    expect(series?.points[0]?.hour).toBe(HOUR_16.toISOString())
  })

  // Порожня лінія в легенді однаково виглядає і як «канал мовчав», і як
  // «канал дешевий».
  it('keeps a group with no points out of the answer entirely', () => {
    const history = build([point()])

    expect(history.series.map((s) => s.groupId)).toEqual(['jito'])
  })

  it('counts the hours that actually have data, not the hours asked for', () => {
    const history = build([
      point({ hour: HOUR_17 }),
      point({ hour: HOUR_17, groupId: 'rpc' }),
      point({ hour: HOUR_16 }),
    ])

    expect(history.coveredHours).toBe(2)
    expect(history.hours).toBe(24)
  })

  // Інакше дашборд суперечив би сам собі: таблиця каже «недостатньо даних»,
  // а графік поруч малює цю ж групу лінією.
  it('drops an hour below the same threshold the table applies', () => {
    const history = build([point({ groupId: 'nozomi', landings: 21, observations: 21 })])

    expect(history.series).toHaveLength(0)
    // Година все одно була оглянута — глибина історії від порога не залежить.
    expect(history.coveredHours).toBe(1)
    expect(history.minObservations).toBe(50)
  })

  it('passes a missing overpay through as null, not as zero', () => {
    const series = build([point({ overpayP50: null })]).series[0]

    expect(series?.points[0]?.overpayP50).toBeNull()
  })

  it('keeps a negative overpay: landing below the slot reference is not an error', () => {
    const series = build([point({ overpayP50: -1_200n })]).series[0]

    expect(series?.points[0]?.overpayP50).toBe(-1200)
  })

  it('refuses to round a sum that does not fit a safe JSON integer', () => {
    expect(() => build([point({ costP50: BigInt(Number.MAX_SAFE_INTEGER) + 1n })])).toThrow(
      RangeError,
    )
  })
})
