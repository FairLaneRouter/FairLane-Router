import type { Summary, SummaryGroup } from '@fairlane/shared/summary'
import { useState } from 'react'
import CostCanvas from '@/components/CostCanvas'
import Marker from '@/components/Marker'
import OverpayChart from '@/components/OverpayChart'
import { fmtAge, fmtInt, fmtLamports, fmtShare, WINDOW_LABELS } from '@/lib/format'
import type { HistoryState } from '@/lib/useSummary'
import type { SummaryWindow } from '@/lib/api'
import { useHistory, useSummary } from '@/lib/useSummary'

const WINDOWS: { key: SummaryWindow; label: string }[] = [
  { key: '15m', label: '15 min' },
  { key: '1h', label: '1 h' },
  { key: '24h', label: '24 h' },
]

const COLUMNS = ['group', 'landings', 'share', 'p10', 'median', 'p90', 'overpay', 'sendable']

const Figure = ({
  caption,
  value,
  note,
  strong = false,
}: {
  caption: string
  value: string
  note: string
  strong?: boolean
}) => (
  <div className="min-w-[190px] flex-1 border-t border-[hsl(var(--rule))] pt-2">
    <div className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{caption}</div>
    <div
      className={`u-num mt-1 tabular-nums ${strong ? 'text-[26px] font-medium' : 'text-[22px]'} leading-none`}
    >
      {value}
    </div>
    <div className="u-num mt-1 text-[11px] text-[hsl(var(--ink-muted))]">{note}</div>
  </div>
)

/**
 * Найдешевша група серед тих, яким вистачило спостережень. Сервер уже
 * впорядкував групи за медіаною і поставив недостатні в кінець (FR-012), тож
 * шукати мінімум тут не треба — досить узяти першу придатну.
 */
const cheapest = (groups: readonly SummaryGroup[]): SummaryGroup | undefined =>
  groups.find((group) => group.sufficientData)

const Sendability = ({ group }: { group: SummaryGroup }) =>
  group.isSendable ? null : (
    <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
      observed only — cannot route through
    </div>
  )

const Row = ({ group }: { group: SummaryGroup }) => (
  <tr className="border-b border-[hsl(var(--grid-minor))] align-top">
    <td className="py-2 pr-4 text-left">
      <div className="u-label text-[14px] font-semibold leading-tight">{group.name}</div>
      {group.members.length > 1 && (
        <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
          {group.members.join(', ')}
        </div>
      )}
      <Sendability group={group} />
    </td>
    {group.sufficientData ? (
      <>
        <td className="u-num py-2 text-right text-[12px]">{fmtLamports(group.landings)}</td>
        <td className="u-num py-2 text-right text-[12px]">{fmtShare(group.share)}</td>
        <td className="u-num py-2 text-right text-[12px]">{fmtLamports(group.costP10)}</td>
        <td className="u-num py-2 text-right text-[12px] font-medium">
          {fmtLamports(group.costP50)}
        </td>
        <td className="u-num py-2 text-right text-[12px]">{fmtLamports(group.costP90)}</td>
        <td className="u-num py-2 text-right text-[12px] text-[hsl(var(--overpay))]">
          {fmtLamports(group.overpayP50)}
        </td>
        <td className="u-label py-2 text-right text-[12px]">{group.isSendable ? 'yes' : 'no'}</td>
      </>
    ) : (
      <>
        <td className="u-num py-2 text-right text-[12px]">{fmtInt(group.observations)}</td>
        <td colSpan={6} className="u-label py-2 text-right text-[12px] text-[hsl(var(--ink-muted))]">
          not enough data
        </td>
      </>
    )}
  </tr>
)

const NarrowRow = ({ group }: { group: SummaryGroup }) => (
  <div className="border-b border-[hsl(var(--rule))] py-3">
    <div className="u-label text-[15px] font-semibold">{group.name}</div>
    {group.members.length > 1 && (
      <div className="u-label text-[11px] text-[hsl(var(--ink-muted))]">
        {group.members.join(', ')}
      </div>
    )}
    <Sendability group={group} />
    {group.sufficientData ? (
      <dl className="mt-1">
        {(
          [
            ['landings', fmtLamports(group.landings)],
            ['share', fmtShare(group.share)],
            ['p10', fmtLamports(group.costP10)],
            ['median', fmtLamports(group.costP50)],
            ['p90', fmtLamports(group.costP90)],
            ['overpay', fmtLamports(group.overpayP50)],
            ['sendable', group.isSendable ? 'yes' : 'no'],
          ] as [string, string][]
        ).map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between">
            <dt className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{key}</dt>
            <dd
              className={`u-num text-[12px] ${key === 'overpay' ? 'text-[hsl(var(--overpay))]' : ''}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <div className="mt-1 flex justify-between">
        <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">observations</span>
        <span className="u-num text-[12px]">
          {fmtInt(group.observations)} · not enough data
        </span>
      </div>
    )}
  </div>
)

const WindowPicker = ({
  value,
  onChange,
}: {
  value: SummaryWindow
  onChange: (window: SummaryWindow) => void
}) => (
  <section>
    <div className="flex items-center gap-4 border-y border-[hsl(var(--rule))] py-2">
      <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">window</span>
      <div className="flex items-center gap-3">
        {WINDOWS.map((option, index) => (
          <span key={option.key} className="flex items-center gap-3">
            {index > 0 && <span className="text-[hsl(var(--rule))]">·</span>}
            <button
              type="button"
              onClick={() => onChange(option.key)}
              className={`u-num text-[12px] ${
                value === option.key
                  ? 'text-[hsl(var(--ink))] underline underline-offset-4'
                  : 'text-[hsl(var(--ink-muted))] hover:text-[hsl(var(--ink))]'
              }`}
            >
              {option.label}
            </button>
          </span>
        ))}
      </div>
    </div>
  </section>
)

const Live = ({ summary, live }: { summary: Summary; live: boolean }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
      {WINDOW_LABELS[summary.window]} · {fmtInt(summary.slotsSampled)} slots sampled ·{' '}
      {fmtInt(summary.observations)} observations
    </span>
    <Marker>{summary.isStale ? 'STALE' : live ? 'LIVE' : 'RECONNECTING'}</Marker>
    <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
      newest landing {fmtAge(summary.dataAgeMs)}
    </span>
  </div>
)

const Dashboard = ({
  summary,
  live,
  history,
}: {
  summary: Summary
  live: boolean
  history: HistoryState
}) => {
  const best = cheapest(summary.groups)
  const measured = summary.groups.filter((group) => group.sufficientData)
  const withoutData = summary.groups.filter((group) => !group.sufficientData)

  return (
    <div className="space-y-9">
      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="u-caps text-[11px]">Window</h2>
          <Live summary={summary} live={live} />
        </div>

        <div className="flex flex-col gap-x-10 gap-y-5 sm:flex-row">
          <Figure
            caption="cheapest group, median landing"
            value={best === undefined ? '—' : fmtLamports(best.costP50)}
            note={best === undefined ? 'no group has enough data' : `${best.name} · lamports`}
            strong
          />
          <Figure
            caption="its median overpay"
            value={best === undefined ? '—' : fmtLamports(best.overpayP50)}
            note="against the slot reference · lamports"
          />
          <Figure
            caption="unattributed"
            value={fmtShare(summary.unattributed.share)}
            note={`${fmtInt(summary.unattributed.observations)} observations`}
          />
        </div>

        <p className="u-label mt-3 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
          Every figure is a median of landings actually observed in this window, in lamports. There
          are no sums here and no conversion to dollars: the window holds a sample of the slots, not
          all of them, and a sum over a sample would be an extrapolation, not a measurement.
        </p>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="u-caps text-[11px]">Cost per landing</h2>
          <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
            p10 · median · p90, logarithmic axis
          </span>
        </div>
        <div className="overflow-x-auto">
          <CostCanvas groups={measured} />
        </div>
        {measured.length === 0 && (
          <p className="u-label mt-2 text-[12px] text-[hsl(var(--ink-muted))]">
            no group in this window has enough observations to draw
          </p>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="u-caps text-[11px]">Overpay over the day</h2>
          <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
            {history.status === 'ready'
              ? `${fmtInt(history.history.coveredHours)} of ${fmtInt(history.history.hours)} hours have data`
              : 'hourly aggregates'}
          </span>
        </div>

        {history.status === 'loading' && (
          <p className="u-label text-[12px] text-[hsl(var(--ink-muted))]">reading the aggregates…</p>
        )}
        {history.status === 'error' && (
          <p className="u-label text-[12px] text-[hsl(var(--ink-muted))]">{history.message}.</p>
        )}
        {history.status === 'ready' && (
          <>
            <div className="overflow-x-auto">
              <OverpayChart history={history.history} />
            </div>
            <p className="u-label mt-2 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
              One point per completed hour. A missing hour breaks the line instead of being drawn
              through: a segment across a gap would look exactly like a measured one. The history is
              as long as collection has been running, and the count above says how long that is.
            </p>
          </>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-baseline gap-3">
          <h2 className="u-caps text-[11px]">Groups</h2>
        </div>

        <table className="hidden w-full border-collapse md:table">
          <thead>
            <tr className="border-y border-[hsl(var(--rule))]">
              {COLUMNS.map((column, index) => (
                <th
                  key={column}
                  className={`u-caps py-2 text-[9px] font-medium text-[hsl(var(--ink-muted))] ${
                    index === 0 ? 'text-left' : 'text-right'
                  }`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.groups.map((group) => (
              <Row key={group.groupId} group={group} />
            ))}
          </tbody>
        </table>

        <div className="md:hidden">
          {summary.groups.map((group) => (
            <NarrowRow key={group.groupId} group={group} />
          ))}
        </div>

        <p className="u-label mt-3 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
          Landings are an estimate weighted by the storage sample; observations are the rows the
          estimate stands on. A group below {fmtInt(summary.minObservations)} observations gets no
          figures at all and takes no place in the ranking. Shares are divided by the whole window,
          unattributed included, so the visible shares add up to less than 100% — the difference is
          what we do not know.
        </p>
        {withoutData.length > 0 && (
          <p className="u-label mt-2 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
            Without figures in this window:{' '}
            {withoutData.map((group) => group.name).join(', ')}.
          </p>
        )}
      </section>
    </div>
  )
}

const HOUR_MS = 3_600_000

const Board = () => {
  const [window, setWindow] = useState<SummaryWindow>('1h')
  const state = useSummary(window)

  // Годинний агрегат зʼявляється рівно раз на годину, тож перечитувати
  // історію на кожну подію стрічки (раз на сорок секунд) немає за чим.
  const hourOfData =
    state.status === 'ready' && state.summary.lastBlockTime !== null
      ? Math.floor(Date.parse(state.summary.lastBlockTime) / HOUR_MS)
      : 0
  const history = useHistory(24, hourOfData)

  return (
    <div className="space-y-9">
      <WindowPicker value={window} onChange={setWindow} />

      {state.status === 'loading' && (
        <p className="u-label text-[13px] text-[hsl(var(--ink-muted))]">
          reading the window…
        </p>
      )}

      {state.status === 'error' && (
        <div className="border border-[hsl(var(--rule))] p-3">
          <div className="u-caps text-[10px]">no data</div>
          <p className="u-label mt-1 max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
            {state.message}. Nothing is shown rather than zeros: an empty table would read as
            «delivery costs nothing», which is a different statement.
          </p>
        </div>
      )}

      {state.status === 'ready' && (
        <Dashboard summary={state.summary} live={state.live} history={history} />
      )}
    </div>
  )
}

export default Board
