import type { History, HistorySeries } from '@fairlane/shared/history'
import { fmtInt } from '@/lib/format'
import { costDomain, domainTicks, logPos, tickLabel } from '@/lib/scale'

const W = 960
const H = 300
const PLOT_L = 64
const PLOT_R = 800
const PLOT_T = 24
const PLOT_B = 236
const HOUR_MS = 3_600_000

/**
 * Штрихи ліній замість кольору. Дошка друкується й знімається на екран у
 * відтінках сірого, а розрізняти канали за кольором означало б зробити графік
 * нечитним рівно там, де він найчастіше й опиняється — у скріншоті.
 */
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 3'] as const

interface OverpayChartProps {
  history: History
}

type Placed = {
  readonly x: number
  readonly y: number
  readonly hour: number
  readonly overpay: number
  /** Надлишок нижче осі: посадки цієї години сіли не дорожче за еталон. */
  readonly atFloor: boolean
}

/**
 * Зміна медіанного надлишку по групах за добу (FR-013).
 *
 * Лінія рветься на кожній пропущеній годині і не з'єднує сусідів через
 * порожнечу: відрізок через прогалину домальовував би значення, яких ніхто не
 * міряв, і виглядав би точно так само, як виміряний.
 *
 * Вісь надлишку логарифмічна, бо канали розходяться на три порядки — від
 * тисячі лампортів у звичайного RPC до мільйона в Nozomi. Надлишок нуль або
 * менший на такій осі місця не має, і точка тоді сідає на саму вісь порожнім
 * маркером: «не дорожче за еталон» — це твердження про величину, а не її
 * відсутність.
 */
const OverpayChart = ({ history }: OverpayChartProps) => {
  const series = history.series.filter((line) =>
    line.points.some((point) => point.overpayP50 !== null),
  )

  const domain = costDomain(
    series.flatMap((line) =>
      line.points
        .map((point) => point.overpayP50)
        .filter((value): value is number => value !== null && value > 0),
    ),
  )

  const from = Date.parse(history.from)
  const to = Date.parse(history.to)
  const x = (hour: number) => PLOT_L + ((hour - from) / (to - from)) * (PLOT_R - PLOT_L)
  const y = (value: number) =>
    logPos(Math.min(Math.max(value, domain.min), domain.max), domain.min, domain.max, PLOT_B, PLOT_T)

  const place = (line: HistorySeries): Placed[] =>
    line.points
      .filter((point) => point.overpayP50 !== null)
      .map((point) => {
        const overpay = point.overpayP50 ?? 0
        return {
          x: x(Date.parse(point.hour)),
          y: overpay > 0 ? y(overpay) : PLOT_B,
          hour: Date.parse(point.hour),
          overpay,
          atFloor: overpay <= 0,
        }
      })

  /** Сусідні години з'єднуються, розірвані — ні. */
  const segments = (points: readonly Placed[]): Placed[][] => {
    const parts: Placed[][] = []
    let current: Placed[] = []

    for (const point of points) {
      const previous = current.at(-1)
      if (previous !== undefined && point.hour - previous.hour > HOUR_MS) {
        parts.push(current)
        current = []
      }
      current.push(point)
    }
    if (current.length > 0) parts.push(current)

    return parts
  }

  const hourTicks: number[] = []
  const step = Math.max(1, Math.round((to - from) / HOUR_MS / 8)) * HOUR_MS
  for (let hour = to; hour >= from; hour -= step) hourTicks.push(hour)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full min-w-[860px]"
      role="img"
      aria-label="Median overpay by delivery group over time, logarithmic axis"
    >
      <text className="u-caps" x={PLOT_L} y={12} fontSize={9} fill="hsl(var(--ink-muted))">
        median overpay — lamports — logarithmic axis
      </text>

      {domainTicks(domain).map((tick) => (
        <g key={tick}>
          <line
            x1={PLOT_L}
            y1={y(tick)}
            x2={PLOT_R}
            y2={y(tick)}
            stroke="hsl(var(--grid-minor))"
          />
          <text
            className="u-num"
            x={PLOT_L - 6}
            y={y(tick) + 3}
            fontSize={9}
            textAnchor="end"
            fill="hsl(var(--ink-muted))"
          >
            {tickLabel(tick)}
          </text>
        </g>
      ))}

      {hourTicks.map((hour) => (
        <text
          key={hour}
          className="u-num"
          x={x(hour)}
          y={PLOT_B + 14}
          fontSize={9}
          textAnchor="middle"
          fill="hsl(var(--ink-muted))"
        >
          {new Date(hour).toISOString().slice(11, 16)}
        </text>
      ))}

      <line x1={PLOT_L} y1={PLOT_B} x2={PLOT_R} y2={PLOT_B} stroke="hsl(var(--rule))" />
      <text
        className="u-caps"
        x={PLOT_R}
        y={PLOT_B + 26}
        fontSize={8.5}
        textAnchor="end"
        fill="hsl(var(--ink-muted))"
      >
        utc
      </text>

      {series.length === 0 && (
        <text
          className="u-caps"
          x={(PLOT_L + PLOT_R) / 2}
          y={(PLOT_T + PLOT_B) / 2}
          fontSize={11}
          textAnchor="middle"
          fill="hsl(var(--ink-muted))"
        >
          no hour in this range has enough observations
        </text>
      )}

      {series.map((line, index) => {
        const points = place(line)
        const dash = DASHES[index % DASHES.length] ?? ''
        const last = points.at(-1)

        return (
          <g key={line.groupId}>
            {segments(points).map((segment) => (
              <polyline
                key={segment[0]?.hour}
                points={segment.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke="hsl(var(--ink))"
                strokeWidth={1.25}
                strokeDasharray={dash === '' ? undefined : dash}
                strokeOpacity={line.isSendable ? 1 : 0.55}
              />
            ))}

            {points.map((point) => (
              <rect
                key={point.hour}
                x={point.x - 2.5}
                y={point.y - 2.5}
                width={5}
                height={5}
                fill={point.atFloor ? 'hsl(var(--paper))' : 'hsl(var(--ink))'}
                stroke="hsl(var(--ink))"
              />
            ))}

            {last !== undefined && (
              <text
                className="u-label"
                x={PLOT_R + 8}
                y={last.y + 3}
                fontSize={11}
                fill="hsl(var(--ink))"
              >
                {line.name} · {fmtInt(last.overpay)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export default OverpayChart
