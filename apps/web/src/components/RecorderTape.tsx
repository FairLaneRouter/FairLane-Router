import { useEffect, useMemo, useState } from 'react'
import { fmtInt, TAPE } from '@/lib/mock'
import { logPos } from '@/lib/scale'

const W = 960
const H = 128
const PLOT_L = 4
const PLOT_R = 812
const PLOT_T = 12
const PLOT_B = 110
const D_MIN = 5_000
const D_MAX = 1_500_000
const LABEL_MIN_GAP = 13

type Trace = {
  readonly id: string
  readonly name: string
  readonly volatility: number
  readonly base: number
  readonly points: readonly number[]
}

const last = (points: readonly number[], fallback: number): number => points.at(-1) ?? fallback

// Поза компонентом: залежить лише від констант модуля, тож не має бути
// залежністю useMemo — інакше меморизація перестає щось означати.
const y = (value: number) => logPos(value, D_MIN, D_MAX, PLOT_B, PLOT_T)

const nextSample = (prev: number, base: number, volatility: number): number => {
  const drift = (base - prev) * 0.28
  const jitter = (Math.random() - 0.5) * 2 * volatility * base
  return Math.max(D_MIN * 1.05, Math.round(prev + drift + jitter))
}

const initialTraces = (): Trace[] =>
  TAPE.map((series) => ({
    id: series.id,
    name: series.name,
    volatility: series.volatility,
    base: last(series.points, D_MIN),
    points: [...series.points],
  }))

/**
 * A pen trace. Median overpay per group, scrolling right to left.
 * Nothing else on the board animates.
 */
const RecorderTape = () => {
  const [traces, setTraces] = useState<Trace[]>(initialTraces)

  useEffect(() => {
    const id = window.setInterval(() => {
      setTraces((previous) =>
        previous.map((trace) => ({
          ...trace,
          points: [
            ...trace.points.slice(1),
            nextSample(last(trace.points, trace.base), trace.base, trace.volatility),
          ],
        })),
      )
    }, 3000)

    return () => window.clearInterval(id)
  }, [])

  const count = traces.at(0)?.points.length ?? 0
  const stepX = count > 1 ? (PLOT_R - PLOT_L) / (count - 1) : 0

  // Підписи розсуваються по вертикалі, щоб не злипались: Halyard і Northlane
  // на логарифмічній шкалі стоять близько і без цього накладаються.
  const labels = useMemo(() => {
    const placed: { id: string; name: string; value: number; y: number }[] = []

    for (const trace of traces
      .map((trace) => {
        const value = last(trace.points, trace.base)
        return { id: trace.id, name: trace.name, value, y: y(value) }
      })
      .sort((a, b) => a.y - b.y)) {
      const previousY = placed.at(-1)?.y
      placed.push(
        previousY !== undefined && trace.y - previousY < LABEL_MIN_GAP
          ? { ...trace, y: previousY + LABEL_MIN_GAP }
          : trace,
      )
    }

    return placed
  }, [traces])

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full min-w-[860px]"
      role="img"
      aria-label="Recorder tape: median overpay per group over the last 60 minutes"
    >
      <line
        x1={PLOT_L}
        y1={PLOT_T - 4}
        x2={PLOT_R}
        y2={PLOT_T - 4}
        stroke="hsl(var(--rule))"
        strokeWidth={1}
      />
      <line
        x1={PLOT_L}
        y1={PLOT_B + 6}
        x2={PLOT_R}
        y2={PLOT_B + 6}
        stroke="hsl(var(--rule))"
        strokeWidth={1}
      />
      <line
        x1={PLOT_R}
        y1={PLOT_T - 4}
        x2={PLOT_R}
        y2={PLOT_B + 6}
        stroke="hsl(var(--rule))"
        strokeWidth={1}
      />

      {traces.map((trace) => (
        <polyline
          key={trace.id}
          fill="none"
          stroke="hsl(var(--ink))"
          strokeWidth={trace.id === 'kestrel' ? 1.4 : 1}
          strokeLinejoin="round"
          strokeOpacity={trace.id === 'halyard' ? 0.45 : 0.9}
          strokeDasharray={trace.id === 'halyard' ? '3 2' : undefined}
          points={trace.points
            .map((value, index) => `${PLOT_L + index * stepX},${y(value).toFixed(2)}`)
            .join(' ')}
        />
      ))}

      {traces.map((trace) => (
        <rect
          key={`head-${trace.id}`}
          x={PLOT_R - 2}
          y={y(last(trace.points, trace.base)) - 2}
          width={4}
          height={4}
          fill="hsl(var(--ink))"
        />
      ))}

      {labels.map((label) => (
        <g key={label.id}>
          <text
            className="u-caps"
            x={PLOT_R + 10}
            y={label.y + 3}
            fontSize={9}
            fill="hsl(var(--ink-muted))"
          >
            {label.name}
          </text>
          <text
            className="u-num"
            x={W - 4}
            y={label.y + 3}
            fontSize={9.5}
            textAnchor="end"
            fill="hsl(var(--ink))"
          >
            {fmtInt(label.value)}
          </text>
        </g>
      ))}

      <text className="u-caps" x={PLOT_L} y={H - 4} fontSize={9} fill="hsl(var(--ink-muted))">
        last 60 min · median overpay, lamports · log scale
      </text>
    </svg>
  )
}

export default RecorderTape
