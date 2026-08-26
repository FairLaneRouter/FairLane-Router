import { useState } from 'react'
import CostCanvas from '@/components/CostCanvas'
import Marker from '@/components/Marker'
import RecorderTape from '@/components/RecorderTape'
import {
  fmtInt,
  fmtUsd,
  GROUPS,
  REFERENCE_LAMPORTS,
  SOL_USD,
  WINDOW_SLOTS_SAMPLED,
  WINDOW_TOTAL_LANDINGS,
  WINDOW_TOTALS,
} from '@/lib/mock'

type WindowKey = '15 min' | '1 h' | '24 h'
const WINDOWS: WindowKey[] = ['15 min', '1 h', '24 h']

const Total = ({
  caption,
  lamports,
  sol,
  usd,
  strong = false,
}: {
  caption: string
  lamports: number
  sol: string
  usd: number
  strong?: boolean
}) => (
  <div className="min-w-[190px] flex-1 border-t border-[hsl(var(--rule))] pt-2">
    <div className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{caption}</div>
    <div
      className={`u-num mt-1 tabular-nums ${
        strong ? 'text-[26px] font-medium' : 'text-[22px]'
      } leading-none`}
    >
      {fmtUsd(usd)}
    </div>
    <div className="u-num mt-1 text-[11px] text-[hsl(var(--ink-muted))]">{sol} SOL</div>
    <div className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
      {fmtInt(lamports)} lamports
    </div>
  </div>
)

const Board = () => {
  const [win, setWin] = useState<WindowKey>('15 min')
  const empty = win !== '15 min'
  const rows = GROUPS

  return (
    <div className="space-y-9">
      {/* window totals */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="u-caps text-[11px]">Window totals</h2>
          <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
            last 15 minutes · {WINDOW_SLOTS_SAMPLED} slots sampled · {fmtInt(WINDOW_TOTAL_LANDINGS)}{' '}
            landings
          </span>
          <Marker />
        </div>

        <div className="flex flex-col gap-x-10 gap-y-5 sm:flex-row">
          <Total
            caption="paid for delivery"
            lamports={WINDOW_TOTALS.paid.lamports}
            sol={WINDOW_TOTALS.paid.sol}
            usd={WINDOW_TOTALS.paid.usd}
          />
          <Total
            caption="would have cost at the reference"
            lamports={WINDOW_TOTALS.atReference.lamports}
            sol={WINDOW_TOTALS.atReference.sol}
            usd={WINDOW_TOTALS.atReference.usd}
          />
          <Total
            caption="overpay"
            lamports={WINDOW_TOTALS.overpay.lamports}
            sol={WINDOW_TOTALS.overpay.sol}
            usd={WINDOW_TOTALS.overpay.usd}
            strong
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="u-num text-[12px] text-[hsl(var(--ink-muted))]">
            at this rate, {fmtUsd(WINDOW_TOTALS.extrapolatedPerDayUsd, 0)} per day
          </span>
          <Marker>extrapolated</Marker>
          <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
            SOL = ${SOL_USD.toFixed(2)}
          </span>
        </div>
      </section>

      {/* recorder tape */}
      <section>
        <div className="mb-1 flex items-baseline gap-3">
          <h2 className="u-caps text-[11px]">Recorder tape</h2>
          <Marker />
        </div>
        <div className="overflow-x-auto">
          <RecorderTape />
        </div>
      </section>

      {/* canvas */}
      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="u-caps text-[11px]">Cost per landing</h2>
          <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
            reference {fmtInt(REFERENCE_LAMPORTS)} lamports
          </span>
          <Marker />
        </div>
        <div className="overflow-x-auto">
          <CostCanvas empty={empty} />
        </div>
        {empty && (
          <p className="u-label mt-2 text-[12px] text-[hsl(var(--ink-muted))]">
            no samples in this window
          </p>
        )}
      </section>

      {/* window selector */}
      <section>
        <div className="flex items-center gap-4 border-y border-[hsl(var(--rule))] py-2">
          <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">window</span>
          <div className="flex items-center gap-3">
            {WINDOWS.map((w, i) => (
              <span key={w} className="flex items-center gap-3">
                {i > 0 && <span className="text-[hsl(var(--rule))]">·</span>}
                <button
                  type="button"
                  onClick={() => setWin(w)}
                  className={`u-num text-[12px] ${
                    win === w
                      ? 'text-[hsl(var(--ink))] underline underline-offset-4'
                      : 'text-[hsl(var(--ink-muted))] hover:text-[hsl(var(--ink))]'
                  }`}
                >
                  {w}
                </button>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* table */}
      <section>
        <div className="mb-2 flex items-baseline gap-3">
          <h2 className="u-caps text-[11px]">Groups</h2>
          <Marker />
        </div>

        {empty ? (
          <p className="u-label border-t border-[hsl(var(--rule))] pt-2 text-[12px] text-[hsl(var(--ink-muted))]">
            no samples in this window
          </p>
        ) : (
          <>
            {/* wide */}
            <table className="hidden w-full border-collapse md:table">
              <thead>
                <tr className="border-y border-[hsl(var(--rule))]">
                  {[
                    'group',
                    'landings',
                    'share',
                    'p10',
                    'median',
                    'p90',
                    'overpay',
                    'sendable',
                  ].map((h, i) => (
                    <th
                      key={h}
                      className={`u-caps py-2 text-[9px] font-medium text-[hsl(var(--ink-muted))] ${
                        i === 0 ? 'text-left' : 'text-right'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id} className="border-b border-[hsl(var(--grid-minor))] align-top">
                    <td className="py-2 pr-4 text-left">
                      <div className="u-label text-[14px] font-semibold leading-tight">
                        {g.name}
                      </div>
                      {g.members && (
                        <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
                          {g.members.join(', ')}
                        </div>
                      )}
                      {g.sendable === 'no' && (
                        <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
                          observed only — cannot route through
                        </div>
                      )}
                    </td>
                    {!g.enoughData ? (
                      <>
                        <td className="u-num py-2 text-right text-[12px]">{fmtInt(g.landings)}</td>
                        <td
                          colSpan={6}
                          className="u-label py-2 text-right text-[12px] text-[hsl(var(--ink-muted))]"
                        >
                          not enough data
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="u-num py-2 text-right text-[12px]">{fmtInt(g.landings)}</td>
                        <td className="u-num py-2 text-right text-[12px]">
                          {g.share?.toFixed(1)}%
                        </td>
                        <td className="u-num py-2 text-right text-[12px]">
                          {g.p10 === null ? '—' : fmtInt(g.p10)}
                        </td>
                        <td className="u-num py-2 text-right text-[12px] font-medium">
                          {fmtInt(g.median as number)}
                        </td>
                        <td className="u-num py-2 text-right text-[12px]">
                          {g.p90 === null ? '—' : fmtInt(g.p90)}
                        </td>
                        <td className="u-num py-2 text-right text-[12px] text-[hsl(var(--overpay))]">
                          {fmtInt(g.overpay as number)}
                        </td>
                        <td className="u-label py-2 text-right text-[12px]">
                          {g.sendable === 'yes' ? 'yes' : g.sendable === 'no' ? 'no' : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* narrow */}
            <div className="md:hidden">
              {rows.map((g) => (
                <div key={g.id} className="border-b border-[hsl(var(--rule))] py-3">
                  <div className="u-label text-[15px] font-semibold">{g.name}</div>
                  {g.members && (
                    <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
                      {g.members.join(', ')}
                    </div>
                  )}
                  {g.sendable === 'no' && (
                    <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
                      observed only — cannot route through
                    </div>
                  )}
                  {!g.enoughData ? (
                    <div className="mt-1 flex justify-between">
                      <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">
                        landings
                      </span>
                      <span className="u-num text-[12px]">
                        {fmtInt(g.landings)} · not enough data
                      </span>
                    </div>
                  ) : (
                    <dl className="mt-1">
                      {(
                        [
                          ['landings', fmtInt(g.landings)],
                          ['share', `${g.share?.toFixed(1)}%`],
                          ['p10', g.p10 === null ? '—' : fmtInt(g.p10)],
                          ['median', fmtInt(g.median as number)],
                          ['p90', g.p90 === null ? '—' : fmtInt(g.p90)],
                          ['overpay', fmtInt(g.overpay as number)],
                          ['sendable', g.sendable === 'unknown' ? '—' : g.sendable],
                        ] as [string, string][]
                      ).map(([k, v]) => (
                        <div key={k} className="flex items-baseline justify-between">
                          <dt className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{k}</dt>
                          <dd
                            className={`u-num text-[12px] ${
                              k === 'overpay' ? 'text-[hsl(var(--overpay))]' : ''
                            }`}
                          >
                            {v}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ))}
            </div>

            <p className="u-label mt-3 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
              Shares are rounded to one decimal and sum to 99.9%. Torrent is below the minimum
              sample count, is not counted in the {fmtInt(WINDOW_TOTAL_LANDINGS)} total and is not
              drawn on the canvas.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

export default Board
