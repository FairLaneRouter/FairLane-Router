import type { SummaryGroup } from '@fairlane/shared/summary'
import { fmtInt } from '@/lib/format'
import { costDomain, domainTicks, logPos, tickLabel } from '@/lib/scale'

const W = 960
const PLOT_L = 188
const PLOT_R = 780
const AXIS_TOP = 30
const ROW_H = 48
const LABEL_R = 172
const FIGURE_R = 956

interface CostCanvasProps {
  /** Тільки групи з достатніми даними: решті малювати нічого (FR-012). */
  groups: readonly SummaryGroup[]
}

/**
 * Вартість посадки по групах на логарифмічній осі.
 *
 * Єдиної лінії еталона тут більше немає, і це вимушено: еталон рахується
 * **на кожен слот окремо** (FR-005), а вікно зведення охоплює десятки слотів
 * з різними еталонами. Одна вертикаль означала б, що еталон у вікні один, —
 * твердження, якого дані не роблять. Замість неї кожен рядок має власну
 * заливку від `медіана − медіанний надлишок` до медіани: це та сама величина,
 * яку показує колонка «overpay», лише в масштабі осі.
 */
const CostCanvas = ({ groups }: CostCanvasProps) => {
  const domain = costDomain(
    groups.flatMap((group) =>
      [group.costP10, group.costP50, group.costP90].filter((value): value is number =>
        value !== null,
      ),
    ),
  )
  const x = (value: number) =>
    logPos(Math.min(Math.max(value, domain.min), domain.max), domain.min, domain.max, PLOT_L, PLOT_R)

  const plotBottom = AXIS_TOP + Math.max(groups.length, 3) * ROW_H
  const H = plotBottom + 24

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full min-w-[860px]"
      role="img"
      aria-label="Cost per landing by delivery group on a logarithmic axis"
    >
      <text className="u-caps" x={PLOT_L} y={12} fontSize={9} fill="hsl(var(--ink-muted))">
        cost per landing — lamports — logarithmic axis
      </text>

      {domainTicks(domain).map((tick) => (
        <g key={tick}>
          <line
            x1={x(tick)}
            y1={AXIS_TOP}
            x2={x(tick)}
            y2={plotBottom}
            stroke={tick === domain.min || tick === domain.max ? 'hsl(var(--grid-major))' : 'hsl(var(--grid-minor))'}
            strokeWidth={1}
          />
          <text
            className="u-num"
            x={x(tick)}
            y={AXIS_TOP - 8}
            fontSize={9}
            textAnchor="middle"
            fill="hsl(var(--ink-muted))"
          >
            {tickLabel(tick)}
          </text>
        </g>
      ))}

      <line x1={PLOT_L} y1={AXIS_TOP} x2={PLOT_R} y2={AXIS_TOP} stroke="hsl(var(--rule))" />
      <line x1={PLOT_L} y1={plotBottom} x2={PLOT_R} y2={plotBottom} stroke="hsl(var(--rule))" />

      {groups.length === 0 && (
        <text
          className="u-caps"
          x={(PLOT_L + PLOT_R) / 2}
          y={AXIS_TOP + 1.5 * ROW_H}
          fontSize={11}
          textAnchor="middle"
          fill="hsl(var(--ink-muted))"
        >
          no group has enough observations
        </text>
      )}

      {groups.map((group, index) => {
        const cy = AXIS_TOP + index * ROW_H + ROW_H / 2
        const median = group.costP50
        if (median === null) return null

        const outline = !group.isSendable
        const reference = group.overpayP50 === null ? null : median - group.overpayP50
        const mx = x(median)
        const rx = reference === null ? mx : x(reference)

        return (
          <g key={group.groupId}>
            <line
              x1={PLOT_L}
              y1={cy + ROW_H / 2}
              x2={PLOT_R}
              y2={cy + ROW_H / 2}
              stroke="hsl(var(--grid-minor))"
            />

            <text
              className="u-label"
              x={LABEL_R}
              y={cy + (group.members.length > 1 ? -1 : 3)}
              fontSize={14}
              fontWeight={600}
              textAnchor="end"
              fill="hsl(var(--ink))"
            >
              {group.name}
            </text>
            {group.members.length > 1 && (
              <text
                className="u-label"
                x={LABEL_R}
                y={cy + 12}
                fontSize={10.5}
                textAnchor="end"
                fill="hsl(var(--ink-muted))"
              >
                {group.members.join(', ')}
              </text>
            )}
            {outline && (
              <text
                className="u-caps"
                x={LABEL_R}
                y={cy + (group.members.length > 1 ? 24 : 16)}
                fontSize={8.5}
                textAnchor="end"
                fill="hsl(var(--ink-muted))"
              >
                observed only
              </text>
            )}

            {/* надлишок: від імовірного еталона до медіани */}
            {reference !== null && (
              <rect
                x={Math.min(rx, mx)}
                y={cy - 8}
                width={Math.max(Math.abs(mx - rx), 0.5)}
                height={16}
                fill={outline ? 'none' : 'hsl(var(--overpay) / 0.16)'}
                stroke="hsl(var(--overpay))"
                strokeWidth={outline ? 1 : 0}
                strokeDasharray={outline ? '3 2' : undefined}
                strokeOpacity={0.7}
              />
            )}

            {group.costP10 !== null && group.costP90 !== null && (
              <>
                <line
                  x1={x(group.costP10)}
                  y1={cy}
                  x2={x(group.costP90)}
                  y2={cy}
                  stroke="hsl(var(--ink))"
                  strokeOpacity={outline ? 0.5 : 1}
                />
                <line
                  x1={x(group.costP10)}
                  y1={cy - 5}
                  x2={x(group.costP10)}
                  y2={cy + 5}
                  stroke="hsl(var(--ink))"
                  strokeOpacity={outline ? 0.5 : 1}
                />
                <line
                  x1={x(group.costP90)}
                  y1={cy - 5}
                  x2={x(group.costP90)}
                  y2={cy + 5}
                  stroke="hsl(var(--ink))"
                  strokeOpacity={outline ? 0.5 : 1}
                />
              </>
            )}

            <rect
              x={mx - 4.5}
              y={cy - 4.5}
              width={9}
              height={9}
              fill={outline ? 'hsl(var(--paper))' : 'hsl(var(--ink))'}
              stroke="hsl(var(--ink))"
            />

            <text
              className="u-num"
              x={FIGURE_R}
              y={cy - 3}
              fontSize={12}
              textAnchor="end"
              fill="hsl(var(--ink))"
            >
              {fmtInt(median)}
            </text>
            <text
              className="u-num"
              x={FIGURE_R}
              y={cy + 11}
              fontSize={10.5}
              textAnchor="end"
              fill="hsl(var(--overpay))"
            >
              {group.overpayP50 === null ? 'no reference' : `+${fmtInt(group.overpayP50)}`}
            </text>
          </g>
        )
      })}

      {groups.length > 0 && (
        <>
          <text
            className="u-caps"
            x={FIGURE_R}
            y={AXIS_TOP - 18}
            fontSize={9}
            textAnchor="end"
            fill="hsl(var(--ink-muted))"
          >
            median
          </text>
          <text
            className="u-caps"
            x={FIGURE_R}
            y={AXIS_TOP - 8}
            fontSize={9}
            textAnchor="end"
            fill="hsl(var(--ink-muted))"
          >
            overpay
          </text>
        </>
      )}
    </svg>
  )
}

export default CostCanvas
