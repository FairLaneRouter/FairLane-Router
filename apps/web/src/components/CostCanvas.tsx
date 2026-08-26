import { fmtInt, fmtUsdFromLamports, GROUPS, REFERENCE_LAMPORTS } from '@/lib/mock'
import { AXIS_MAX, AXIS_MIN, COST_TICKS, logPos, tickLabel } from '@/lib/scale'

const W = 960
const PLOT_L = 188
const PLOT_R = 706
const AXIS_TOP = 30
const ROW_H = 48

interface CostCanvasProps {
  empty?: boolean
}

const x = (v: number) => logPos(v, AXIS_MIN, AXIS_MAX, PLOT_L, PLOT_R)

const CostCanvas = ({ empty = false }: CostCanvasProps) => {
  const rows = empty ? [] : GROUPS.filter((g) => g.enoughData && g.median !== null)
  const plotBottom = AXIS_TOP + Math.max(rows.length, 3) * ROW_H
  const H = plotBottom + 42
  const refX = x(REFERENCE_LAMPORTS)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full min-w-[860px]"
      role="img"
      aria-label="Cost per landing by delivery group on a logarithmic axis"
    >
      {/* axis caption */}
      <text className="u-caps" x={PLOT_L} y={12} fontSize={9} fill="hsl(var(--ink-muted))">
        cost per landing — lamports — logarithmic axis
      </text>

      {/* vertical grid at ticks */}
      {COST_TICKS.map((t) => {
        const isDecade = /^1/.test(String(t)) && t % 10_000 === 0
        return (
          <g key={t}>
            <line
              x1={x(t)}
              y1={AXIS_TOP}
              x2={x(t)}
              y2={plotBottom}
              stroke={isDecade ? 'hsl(var(--grid-major))' : 'hsl(var(--grid-minor))'}
              strokeWidth={1}
            />
            <text
              className="u-num"
              x={x(t)}
              y={AXIS_TOP - 8}
              fontSize={9}
              textAnchor="middle"
              fill="hsl(var(--ink-muted))"
            >
              {tickLabel(t)}
            </text>
          </g>
        )
      })}

      {/* axis rules */}
      <line
        x1={PLOT_L}
        y1={AXIS_TOP}
        x2={PLOT_R}
        y2={AXIS_TOP}
        stroke="hsl(var(--rule))"
        strokeWidth={1}
      />
      <line
        x1={PLOT_L}
        y1={plotBottom}
        x2={PLOT_R}
        y2={plotBottom}
        stroke="hsl(var(--rule))"
        strokeWidth={1}
      />

      {/* reference rule */}
      <line
        x1={refX}
        y1={AXIS_TOP - 2}
        x2={refX}
        y2={plotBottom + 12}
        stroke="hsl(var(--ink))"
        strokeWidth={1.25}
      />
      <text className="u-caps" x={refX + 5} y={plotBottom + 24} fontSize={9} fill="hsl(var(--ink))">
        reference
      </text>
      <text
        className="u-num"
        x={refX + 5}
        y={plotBottom + 36}
        fontSize={9.5}
        fill="hsl(var(--ink-muted))"
      >
        {fmtInt(REFERENCE_LAMPORTS)} lamports · p10 of the slot
      </text>

      {empty && (
        <text
          className="u-caps"
          x={(PLOT_L + PLOT_R) / 2}
          y={AXIS_TOP + 3 * ROW_H * 0.5}
          fontSize={11}
          textAnchor="middle"
          fill="hsl(var(--ink-muted))"
        >
          no samples in this window
        </text>
      )}

      {rows.map((g, i) => {
        const cy = AXIS_TOP + i * ROW_H + ROW_H / 2
        const mx = x(g.median as number)
        const outline = g.sendable === 'no'
        const shadeL = Math.min(refX, mx)
        const shadeW = Math.abs(mx - refX)
        return (
          <g key={g.id}>
            {/* row separator */}
            <line
              x1={PLOT_L}
              y1={cy + ROW_H / 2}
              x2={PLOT_R}
              y2={cy + ROW_H / 2}
              stroke="hsl(var(--grid-minor))"
              strokeWidth={1}
            />

            {/* label */}
            <text
              className="u-label"
              x={172}
              y={cy + (g.members ? -1 : 3)}
              fontSize={14}
              fontWeight={600}
              textAnchor="end"
              fill="hsl(var(--ink))"
            >
              {g.name}
            </text>
            {g.members && (
              <text
                className="u-label"
                x={172}
                y={cy + 12}
                fontSize={10.5}
                textAnchor="end"
                fill="hsl(var(--ink-muted))"
              >
                {g.members.join(', ')}
              </text>
            )}
            {outline && (
              <text
                className="u-caps"
                x={172}
                y={cy + 14}
                fontSize={8.5}
                textAnchor="end"
                fill="hsl(var(--ink-muted))"
              >
                observed only
              </text>
            )}

            {/* overpay shading */}
            <rect
              x={shadeL}
              y={cy - 8}
              width={Math.max(shadeW, 0.5)}
              height={16}
              fill={outline ? 'none' : 'hsl(var(--overpay) / 0.16)'}
              stroke="hsl(var(--overpay))"
              strokeWidth={outline ? 1 : 0}
              strokeDasharray={outline ? '3 2' : undefined}
              strokeOpacity={0.7}
            />

            {/* p10 – p90 */}
            {g.p10 !== null && g.p90 !== null && (
              <>
                <line
                  x1={x(g.p10)}
                  y1={cy}
                  x2={x(g.p90)}
                  y2={cy}
                  stroke="hsl(var(--ink))"
                  strokeWidth={1}
                  strokeOpacity={outline ? 0.5 : 1}
                />
                <line
                  x1={x(g.p10)}
                  y1={cy - 5}
                  x2={x(g.p10)}
                  y2={cy + 5}
                  stroke="hsl(var(--ink))"
                  strokeWidth={1}
                  strokeOpacity={outline ? 0.5 : 1}
                />
                <line
                  x1={x(g.p90)}
                  y1={cy - 5}
                  x2={x(g.p90)}
                  y2={cy + 5}
                  stroke="hsl(var(--ink))"
                  strokeWidth={1}
                  strokeOpacity={outline ? 0.5 : 1}
                />
              </>
            )}

            {/* median */}
            <rect
              x={mx - 4.5}
              y={cy - 4.5}
              width={9}
              height={9}
              fill={outline ? 'hsl(var(--paper))' : 'hsl(var(--ink))'}
              stroke="hsl(var(--ink))"
              strokeWidth={1}
            />

            {g.p10 === null && (
              <text
                className="u-caps"
                x={mx + 9}
                y={cy + 3}
                fontSize={8.5}
                fill="hsl(var(--ink-muted))"
              >
                median only
              </text>
            )}

            {/* right-hand figures */}
            <text
              className="u-num"
              x={866}
              y={cy + 3}
              fontSize={12}
              textAnchor="end"
              fill="hsl(var(--ink))"
            >
              {fmtInt(g.median as number)}
            </text>
            <text
              className="u-num"
              x={956}
              y={cy + 3}
              fontSize={11}
              textAnchor="end"
              fill="hsl(var(--ink-muted))"
            >
              {fmtUsdFromLamports(g.median as number)}
            </text>
          </g>
        )
      })}

      {!empty && (
        <>
          <text
            className="u-caps"
            x={866}
            y={AXIS_TOP - 8}
            fontSize={9}
            textAnchor="end"
            fill="hsl(var(--ink-muted))"
          >
            median
          </text>
          <text
            className="u-caps"
            x={956}
            y={AXIS_TOP - 8}
            fontSize={9}
            textAnchor="end"
            fill="hsl(var(--ink-muted))"
          >
            usd
          </text>
        </>
      )}
    </svg>
  )
}

export default CostCanvas
