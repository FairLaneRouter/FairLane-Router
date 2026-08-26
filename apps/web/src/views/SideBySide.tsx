import { useState } from 'react'
import Marker from '@/components/Marker'
import {
  BUDGET,
  fmtInt,
  fmtSol,
  fmtUsd,
  fmtUsdFromLamports,
  RUN_DIFFERENCE,
  RUN_FIXED,
  RUN_ROUTED,
  type RunPanel,
  SOL_USD,
} from '@/lib/mock'
import { linPos } from '@/lib/scale'

const W = 900
const BAR_L = 0
const BAR_R = 780
const DOMAIN = 1_100_000
const TICKS = [0, 200_000, 400_000, 600_000, 800_000, 1_000_000]

type Mode = 'normal' | 'failed' | 'exhausted'

const px = (v: number) => linPos(v, DOMAIN, BAR_L, BAR_R)

const Axis = () => (
  <svg
    viewBox={`0 0 ${W} 26`}
    className="h-auto w-full min-w-[640px]"
    role="img"
    aria-label="Cost axis, 0 to 1,100,000 lamports, shared by both panels"
  >
    <line x1={BAR_L} y1={18} x2={BAR_R} y2={18} stroke="hsl(var(--rule))" strokeWidth={1} />
    {TICKS.map((t) => (
      <g key={t}>
        <line x1={px(t)} y1={14} x2={px(t)} y2={18} stroke="hsl(var(--rule))" strokeWidth={1} />
        <text
          className="u-num"
          x={px(t)}
          y={10}
          fontSize={9}
          textAnchor="middle"
          fill="hsl(var(--ink-muted))"
        >
          {t === 0 ? '0' : `${t / 1000}k`}
        </text>
      </g>
    ))}
    <text className="u-caps" x={BAR_R + 8} y={18} fontSize={9} fill="hsl(var(--ink-muted))">
      lamports · linear
    </text>
  </svg>
)

const StackedBar = ({ run }: { run: RunPanel }) => {
  const segs = [
    { key: 'base fee', value: run.baseFee, fill: 'hsl(var(--ink))' },
    {
      key: 'priority fee',
      value: run.priorityFee,
      fill: 'hsl(var(--ink) / 0.4)',
    },
    { key: 'tip', value: run.tip, fill: 'hsl(var(--overpay) / 0.75)' },
  ].filter((s) => s.value > 0)

  let cursor = 0
  return (
    <svg
      viewBox={`0 0 ${W} 40`}
      className="h-auto w-full min-w-[640px]"
      role="img"
      aria-label={`Cost breakdown: base fee, priority fee and tip, ${run.total} lamports in total`}
    >
      {segs.map((s) => {
        const x0 = px(cursor)
        const w = Math.max(px(s.value) - px(0), 1)
        cursor += s.value
        return <rect key={s.key} x={x0} y={8} width={w} height={20} fill={s.fill} />
      })}
      <rect
        x={BAR_L}
        y={8}
        width={Math.max(px(run.total) - px(0), 1)}
        height={20}
        fill="none"
        stroke="hsl(var(--ink))"
        strokeWidth={1}
      />
      <line
        x1={px(run.total)}
        y1={4}
        x2={px(run.total)}
        y2={36}
        stroke="hsl(var(--ink))"
        strokeWidth={1}
      />
    </svg>
  )
}

const Components = ({ run }: { run: RunPanel }) => (
  <dl className="mt-2 max-w-[420px]">
    {(
      [
        ['base fee', run.baseFee],
        ['priority fee', run.priorityFee],
        ['tip', run.tip],
      ] as [string, number][]
    ).map(([k, v]) => (
      <div
        key={k}
        className="flex items-baseline justify-between border-b border-[hsl(var(--grid-minor))] py-1"
      >
        <dt className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{k}</dt>
        <dd
          className={`u-num text-[12px] ${
            k === 'tip' && v > 0 ? 'text-[hsl(var(--overpay))]' : ''
          }`}
        >
          {fmtInt(v)}
        </dd>
      </div>
    ))}
  </dl>
)

const Panel = ({ run, failed = false }: { run: RunPanel; failed?: boolean }) => (
  <div className="border-t border-[hsl(var(--rule))] pt-3">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{run.label}</span>
      <span className="u-label text-[16px] font-semibold">{run.channel}</span>
      <Marker />
    </div>

    <div className="u-num mt-1 text-[11px] text-[hsl(var(--ink-muted))]">
      {failed ? 'submitted · no landing observed' : `slot ${run.slot} · ${run.slotDelay}`}
    </div>

    <div className="mt-3 overflow-x-auto">
      {failed ? (
        <div className="border-y border-dashed border-[hsl(var(--rule))] py-3">
          <span className="u-label text-[14px]">did not land within 3 slots</span>
          <span className="u-label ml-2 text-[12px] text-[hsl(var(--ink-muted))]">
            no cost can be stated — this is not a zero
          </span>
        </div>
      ) : (
        <StackedBar run={run} />
      )}
    </div>

    {!failed && <Components run={run} />}

    <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">total</span>
      {failed ? (
        <span className="u-label text-[14px]">did not land within 3 slots</span>
      ) : (
        <span className="u-num text-[18px]">
          {fmtInt(run.total)}
          <span className="ml-3 text-[12px] text-[hsl(var(--ink-muted))]">
            {fmtSol(run.total)} SOL
          </span>
          <span className="ml-3 text-[13px]">{fmtUsdFromLamports(run.total)}</span>
        </span>
      )}
    </div>

    <button
      type="button"
      className="u-label mt-2 text-[12px] text-[hsl(var(--ink-muted))] underline underline-offset-4 hover:text-[hsl(var(--ink))]"
    >
      view transaction
    </button>
  </div>
)

const SideBySide = () => {
  const [mode, setMode] = useState<Mode>('normal')
  const [runsLeft, setRunsLeft] = useState(BUDGET.runsLeft)
  const exhausted = mode === 'exhausted' || runsLeft === 0
  const failed = mode === 'failed'

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
          <h2 className="u-caps text-[11px]">The same swap, sent twice</h2>
          <span className="u-label text-[12px] text-[hsl(var(--ink-muted))]">
            once through a naively fixed channel, once through the one the router picked
          </span>
        </div>
        <p className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
          both panels share one cost axis · SOL = ${SOL_USD.toFixed(2)}
        </p>
      </section>

      <div className={exhausted ? 'opacity-45' : undefined}>
        {exhausted && (
          <p className="u-label mb-3 text-[12px] text-[hsl(var(--ink-muted))]">
            budget spent for today — showing the run from {BUDGET.lastRunTime}
          </p>
        )}

        <div className="overflow-x-auto">
          <Axis />
        </div>

        <div className="mt-4 space-y-8">
          <Panel run={RUN_FIXED} failed={failed} />
          <Panel run={RUN_ROUTED} />
        </div>

        <div className="mt-8 border-t border-[hsl(var(--rule))] pt-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">difference</span>
            <Marker />
          </div>
          {failed ? (
            <p className="u-label mt-1 max-w-[70ch] text-[14px]">
              No difference can be stated: the fixed channel did not land within 3 slots, so it has
              no total to compare against.
            </p>
          ) : (
            <p className="u-num mt-1 text-[20px]">
              {fmtInt(RUN_DIFFERENCE.lamports)}
              <span className="ml-3 text-[13px] text-[hsl(var(--ink-muted))]">
                {RUN_DIFFERENCE.sol} SOL
              </span>
              <span className="ml-3 text-[15px]">{fmtUsd(RUN_DIFFERENCE.usd, 4)}</span>
              <span className="ml-3 text-[15px] text-[hsl(var(--overpay))]">
                {RUN_DIFFERENCE.percent}% cheaper
              </span>
            </p>
          )}
        </div>
      </div>

      <section className="border-t border-[hsl(var(--rule))] pt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="u-num text-[12px] text-[hsl(var(--ink-muted))]">
            demo wallet budget: {exhausted ? '0.0000' : BUDGET.remainingSol} SOL of{' '}
            {BUDGET.dailySol} today · {exhausted ? 0 : runsLeft} runs left
          </span>
          <Marker />
          <button
            type="button"
            disabled={exhausted}
            onClick={() => setRunsLeft((r) => Math.max(0, r - 1))}
            className="u-caps border border-[hsl(var(--ink))] px-3 py-[6px] text-[10px] text-[hsl(var(--ink))] hover:bg-[hsl(var(--ink))] hover:text-[hsl(var(--paper))] disabled:cursor-not-allowed disabled:border-[hsl(var(--rule))] disabled:text-[hsl(var(--ink-muted))] disabled:hover:bg-transparent disabled:hover:text-[hsl(var(--ink-muted))]"
          >
            Run again
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
          <button
            type="button"
            onClick={() => setMode(mode === 'failed' ? 'normal' : 'failed')}
            className="u-label text-[12px] text-[hsl(var(--ink-muted))] underline underline-offset-4 hover:text-[hsl(var(--ink))]"
          >
            {mode === 'failed' ? 'show the landed run' : 'show a failed run'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('normal')
              setRunsLeft(exhausted ? BUDGET.runsLeft : 0)
            }}
            className="u-label text-[12px] text-[hsl(var(--ink-muted))] underline underline-offset-4 hover:text-[hsl(var(--ink))]"
          >
            {exhausted ? 'restore the demo budget' : 'show the budget spent state'}
          </button>
        </div>
      </section>
    </div>
  )
}

export default SideBySide
