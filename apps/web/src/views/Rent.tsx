import Marker from '@/components/Marker'
import { APPLICATION, fmtInt, fmtUsd, RENT_ROWS } from '@/lib/mock'

const W = 900
const BAR_L = 0
const BAR_R = 880
const BAR_W = BAR_R - BAR_L

const shade = (id: string, i: number) =>
  id === 'kestrel'
    ? 'hsl(var(--overpay) / 0.75)'
    : `hsl(var(--ink) / ${(0.82 - i * 0.13).toFixed(2)})`

const ShareBar = ({
  caption,
  field,
}: {
  caption: string
  field: 'landingShare' | 'spendShare'
}) => {
  let cursor = 0
  return (
    <g>
      <text className="u-caps" x={BAR_L} y={-8} fontSize={9} fill="hsl(var(--ink-muted))">
        {caption}
      </text>
      {RENT_ROWS.map((r, i) => {
        const w = (r[field] / 100) * BAR_W
        const x0 = BAR_L + cursor
        cursor += w
        return (
          <g key={r.id}>
            <rect x={x0} y={0} width={Math.max(w - 1, 1)} height={26} fill={shade(r.id, i)} />
            {w > 62 && (
              <>
                <text className="u-label" x={x0 + 6} y={12} fontSize={11} fill="hsl(var(--paper))">
                  {r.name}
                </text>
                <text className="u-num" x={x0 + 6} y={23} fontSize={10} fill="hsl(var(--paper))">
                  {r[field].toFixed(1)}%
                </text>
              </>
            )}
            {w <= 62 && (
              <text
                className="u-num"
                x={x0 + w / 2}
                y={40}
                fontSize={9}
                textAnchor="middle"
                fill="hsl(var(--ink-muted))"
              >
                {r[field].toFixed(1)}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

const Rent = () => (
  <div className="space-y-8">
    <section>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="u-caps text-[11px]">Who pays the rent</h2>
        <span className="u-label text-[13px] font-semibold">{APPLICATION.name}</span>
        <span className="u-num text-[11px] text-[hsl(var(--ink-muted))]">
          last {APPLICATION.days} days
        </span>
        <Marker />
      </div>

      <div className="mt-3 flex flex-col gap-x-10 gap-y-4 sm:flex-row">
        <div className="min-w-[180px] flex-1 border-t border-[hsl(var(--rule))] pt-2">
          <div className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">landings</div>
          <div className="u-num mt-1 text-[22px] leading-none">{fmtInt(APPLICATION.landings)}</div>
        </div>
        <div className="min-w-[180px] flex-1 border-t border-[hsl(var(--rule))] pt-2">
          <div className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">paid for delivery</div>
          <div className="u-num mt-1 text-[22px] leading-none">{fmtUsd(APPLICATION.paidUsd)}</div>
          <div className="u-num mt-1 text-[11px] text-[hsl(var(--ink-muted))]">
            {APPLICATION.paidSol.toFixed(2)} SOL
          </div>
        </div>
        <div className="min-w-[180px] flex-1 border-t border-[hsl(var(--rule))] pt-2">
          <div className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">
            overpay against the reference
          </div>
          <div className="u-num mt-1 text-[26px] font-medium leading-none">
            {fmtUsd(APPLICATION.overpayUsd)}
          </div>
          <div className="u-num mt-1 text-[11px] text-[hsl(var(--ink-muted))]">
            {APPLICATION.overpaySol.toFixed(2)} SOL
          </div>
        </div>
      </div>
    </section>

    <section>
      <p className="u-label max-w-[70ch] text-[16px] font-semibold leading-snug">
        Kestrel carried 6.1% of the landings and took 35.9% of the spend.
      </p>

      <div className="mt-5 overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} 150`}
          className="h-auto w-full min-w-[640px]"
          role="img"
          aria-label="Share of landings compared with share of spend"
        >
          <g transform="translate(10, 24)">
            <ShareBar caption="share of landings" field="landingShare" />
          </g>
          <g transform="translate(10, 104)">
            <ShareBar caption="share of spend" field="spendShare" />
          </g>
        </svg>
      </div>
      <div className="mt-1">
        <Marker />
      </div>
    </section>

    <section>
      {/* wide */}
      <table className="hidden w-full border-collapse md:table">
        <thead>
          <tr className="border-y border-[hsl(var(--rule))]">
            {['group', 'landings', 'paid', 'share of spend'].map((h, i) => (
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
          {RENT_ROWS.map((r) => (
            <tr key={r.id} className="border-b border-[hsl(var(--grid-minor))]">
              <td className="u-label py-2 text-left text-[14px] font-semibold">{r.name}</td>
              <td className="u-num py-2 text-right text-[12px]">{fmtInt(r.landings)}</td>
              <td className="u-num py-2 text-right text-[12px]">{r.paidSol.toFixed(2)} SOL</td>
              <td
                className={`u-num py-2 text-right text-[12px] ${
                  r.id === 'kestrel' ? 'text-[hsl(var(--overpay))]' : ''
                }`}
              >
                {r.spendShare.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* narrow */}
      <div className="md:hidden">
        {RENT_ROWS.map((r) => (
          <div key={r.id} className="border-b border-[hsl(var(--rule))] py-3">
            <div className="u-label text-[15px] font-semibold">{r.name}</div>
            {(
              [
                ['landings', fmtInt(r.landings)],
                ['paid', `${r.paidSol.toFixed(2)} SOL`],
                ['share of spend', `${r.spendShare.toFixed(1)}%`],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between">
                <span className="u-caps text-[9px] text-[hsl(var(--ink-muted))]">{k}</span>
                <span className="u-num text-[12px]">{v}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="u-label max-w-[70ch] text-[12px] text-[hsl(var(--ink-muted))]">
          figures older than 48 hours come from hourly aggregates, not from individual transactions
        </p>
        <Marker />
      </div>
    </section>
  </div>
)

export default Rent
