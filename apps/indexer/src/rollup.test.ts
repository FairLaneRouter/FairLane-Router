import { createLogger } from '@fairlane/shared'
import { describe, expect, it } from 'vitest'
import {
  completeHours,
  rollupHour,
  runRollup,
  startOfHour,
  type GroupHourlyRow,
  type HourlyLanding,
  type RollupStore,
} from './rollup.ts'

const HOUR = new Date('2026-08-28T14:00:00.000Z')
const RATE = 0.05

function landing(overrides: Partial<HourlyLanding> = {}): HourlyLanding {
  return {
    groupId: 'jito',
    totalCost: 100_000n,
    overpay: 90_000n,
    isSampled: false,
    ...overrides,
  }
}

function costs(groupId: string, values: readonly bigint[]): HourlyLanding[] {
  return values.map((value) => landing({ groupId, totalCost: value, overpay: null }))
}

const silent = createLogger({ level: 'fatal', sink: () => {} })

function fakeStore(byHour: ReadonlyMap<number, readonly HourlyLanding[]>): RollupStore & {
  readonly saved: GroupHourlyRow[]
  readonly loaded: number[]
} {
  const saved: GroupHourlyRow[] = []
  const loaded: number[] = []

  return {
    saved,
    loaded,
    loadHour: (hour) => {
      loaded.push(hour.getTime())
      return Promise.resolve(byHour.get(hour.getTime()) ?? [])
    },
    save: (rows) => {
      saved.push(...rows)
      return Promise.resolve()
    },
  }
}

describe('startOfHour', () => {
  it('truncates to the start of the UTC hour', () => {
    expect(startOfHour(new Date('2026-08-28T14:59:59.999Z'))).toEqual(HOUR)
  })

  it('leaves an exact hour untouched', () => {
    expect(startOfHour(HOUR)).toEqual(HOUR)
  })
})

describe('completeHours', () => {
  // Поточна година неповна: згорнути її означало б записати агрегат по
  // частині даних, а наступний запуск мовчки замінив би його іншим.
  it('excludes the current hour and returns the previous ones oldest first', () => {
    const hours = completeHours(new Date('2026-08-28T14:20:00.000Z'), 3)

    expect(hours.map((hour) => hour.toISOString())).toEqual([
      '2026-08-28T11:00:00.000Z',
      '2026-08-28T12:00:00.000Z',
      '2026-08-28T13:00:00.000Z',
    ])
  })

  it('rejects a lookback of less than one hour', () => {
    expect(() => completeHours(HOUR, 0)).toThrow(RangeError)
  })
})

describe('rollupHour', () => {
  it('takes percentiles by nearest rank, without interpolating between neighbours', () => {
    const values = [10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n]
    const [row] = rollupHour(HOUR, costs('jito', values), { rpcSampleRate: RATE })

    expect(row?.costP10).toBe(10n)
    expect(row?.costP50).toBe(50n)
    expect(row?.costP90).toBe(90n)
  })

  it('sorts by value, not by the order the landings arrived', () => {
    const [row] = rollupHour(HOUR, costs('jito', [90n, 10n, 50n]), { rpcSampleRate: RATE })

    expect(row?.costP50).toBe(50n)
  })

  // Надлишок буває відʼємним: сісти дешевше за p10 — це ті девʼять відсотків,
  // що під ним. Обрізання в нуль зробило б медіану систематично завищеною.
  it('keeps negative overpay inside the median', () => {
    const rows = rollupHour(
      HOUR,
      [
        landing({ overpay: -3000n }),
        landing({ overpay: -1000n }),
        landing({ overpay: 5000n }),
      ],
      { rpcSampleRate: RATE },
    )

    expect(rows[0]?.overpayP50).toBe(-1000n)
  })

  it('leaves the overpay median empty when no landing of the group had a reference', () => {
    const [row] = rollupHour(HOUR, costs('jito', [10n, 20n]), { rpcSampleRate: RATE })

    expect(row?.overpayP50).toBeNull()
  })

  it('ignores landings without a reference when taking the overpay median', () => {
    const rows = rollupHour(
      HOUR,
      [landing({ overpay: null }), landing({ overpay: 7000n }), landing({ overpay: null })],
      { rpcSampleRate: RATE },
    )

    expect(rows[0]?.overpayP50).toBe(7000n)
  })

  // Без ваги вибірки частка звичайного RPC вийшла б удвадцятеро меншою за
  // справжню — рівно на стільки ми його й проріджуємо при збереженні.
  it('weights a sampled landing as the many it stands for', () => {
    const rows = rollupHour(
      HOUR,
      [landing({ groupId: 'jito' }), landing({ groupId: 'rpc', isSampled: true })],
      { rpcSampleRate: RATE },
    )

    const jito = rows.find((row) => row.groupId === 'jito')
    const rpc = rows.find((row) => row.groupId === 'rpc')

    expect(rpc?.landingsCount).toBe(20)
    expect(jito?.landingsCount).toBe(1)
    expect(rpc?.share).toBeCloseTo(20 / 21, 12)
    expect(jito?.share).toBeCloseTo(1 / 21, 12)
  })

  // `share` має ділитись із `landings_count`, інакше звіт поверх агрегатів
  // (T060) віддавав би два розбіжні числа з одного рядка.
  it('keeps the share consistent with the landings count', () => {
    const rows = rollupHour(
      HOUR,
      [
        landing({ groupId: 'jito' }),
        landing({ groupId: 'nozomi' }),
        landing({ groupId: 'rpc', isSampled: true }),
      ],
      { rpcSampleRate: RATE },
    )

    const total = rows.reduce((sum, row) => sum + row.landingsCount, 0)

    for (const row of rows) expect(row.share).toBeCloseTo(row.landingsCount / total, 12)
  })

  // `group_hourly.group_id` порожнім не буває, тому частка «неатрибутовано»
  // лежить у кожному рядку години — там, де її неможливо не побачити.
  it('gives the unattributed no row of its own but a share in every row', () => {
    const rows = rollupHour(
      HOUR,
      [
        landing({ groupId: 'jito' }),
        landing({ groupId: null }),
        landing({ groupId: null, isSampled: true }),
      ],
      { rpcSampleRate: RATE },
    )

    expect(rows.map((row) => row.groupId)).toEqual(['jito'])
    expect(rows[0]?.unattributedShare).toBeCloseTo(21 / 22, 12)
  })

  it('adds the group shares and the unattributed share up to one', () => {
    const rows = rollupHour(
      HOUR,
      [
        landing({ groupId: 'jito' }),
        landing({ groupId: 'bloxroute' }),
        landing({ groupId: 'rpc', isSampled: true }),
        landing({ groupId: null }),
      ],
      { rpcSampleRate: RATE },
    )

    const total = rows.reduce((sum, row) => sum + row.share, rows[0]?.unattributedShare ?? 0)

    expect(total).toBeCloseTo(1, 12)
  })

  it('stamps every row with the hour it was asked for', () => {
    const rows = rollupHour(HOUR, [landing(), landing({ groupId: 'rpc' })], {
      rpcSampleRate: RATE,
    })

    for (const row of rows) expect(row.hour).toEqual(HOUR)
  })

  it('returns nothing for an hour without landings', () => {
    expect(rollupHour(HOUR, [], { rpcSampleRate: RATE })).toEqual([])
  })
})

describe('runRollup', () => {
  it('rolls up every complete hour of the lookback window', async () => {
    const store = fakeStore(
      new Map([
        [Date.parse('2026-08-28T12:00:00.000Z'), [landing()]],
        [Date.parse('2026-08-28T13:00:00.000Z'), [landing({ groupId: 'rpc' })]],
      ]),
    )

    const summary = await runRollup({
      store,
      logger: silent,
      rpcSampleRate: RATE,
      lookbackHours: 2,
      now: new Date('2026-08-28T14:31:00.000Z'),
    })

    expect(store.loaded).toEqual([
      Date.parse('2026-08-28T12:00:00.000Z'),
      Date.parse('2026-08-28T13:00:00.000Z'),
    ])
    expect(summary).toEqual({ hours: 2, rows: 2, landings: 2 })
    expect(store.saved.map((row) => row.groupId)).toEqual(['jito', 'rpc'])
  })

  // Перерахунок замість журналу зробленого: після простою або дочитування
  // прогалини (T030) друге обчислення години правильніше за перше.
  it('recomputes an hour it has already seen', async () => {
    const hours = new Map([[Date.parse('2026-08-28T13:00:00.000Z'), [landing()]]])
    const store = fakeStore(hours)
    const options = {
      store,
      logger: silent,
      rpcSampleRate: RATE,
      lookbackHours: 1,
      now: new Date('2026-08-28T14:05:00.000Z'),
    }

    await runRollup(options)
    hours.set(Date.parse('2026-08-28T13:00:00.000Z'), [landing(), landing({ groupId: 'rpc' })])
    await runRollup(options)

    expect(store.saved.map((row) => row.groupId)).toEqual(['jito', 'jito', 'rpc'])
  })

  it('writes nothing for an hour without landings', async () => {
    const store = fakeStore(new Map())

    const summary = await runRollup({
      store,
      logger: silent,
      rpcSampleRate: RATE,
      lookbackHours: 3,
      now: new Date('2026-08-28T14:05:00.000Z'),
    })

    expect(store.saved).toEqual([])
    expect(summary).toEqual({ hours: 3, rows: 0, landings: 0 })
  })

  // Частка «неатрибутовано» тут дорівнює одиниці, але покласти її нема куди:
  // рядок агрегату існує тільки при групі. Мовчати про це не можна.
  it('warns instead of writing when an hour has nothing attributed', async () => {
    const lines: string[] = []
    const store = fakeStore(
      new Map([[Date.parse('2026-08-28T13:00:00.000Z'), [landing({ groupId: null })]]]),
    )

    await runRollup({
      store,
      logger: createLogger({ level: 'warn', sink: (line) => lines.push(line) }),
      rpcSampleRate: RATE,
      lookbackHours: 1,
      now: new Date('2026-08-28T14:05:00.000Z'),
    })

    expect(store.saved).toEqual([])
    expect(lines.join('\n')).toContain('без жодної атрибутованої посадки')
  })
})
