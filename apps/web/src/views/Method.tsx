import Marker from '@/components/Marker'
import { fmtInt, REFERENCE_LAMPORTS, RUN_ROUTED } from '@/lib/mock'

const STEPS = [
  'Read the block. Take every successful non-vote transaction in it.',
  'For each transaction, total cost = base fee + priority fee + tips paid to any known service account.',
  'The slot reference is the tenth percentile of those totals. Vote transactions are excluded — they are the majority of a block and pay only the base fee, and including them would drag the reference to nearly zero.',
  'Overpay = that transaction’s total − the slot reference.',
]

const Method = () => (
  <div className="max-w-[68ch] space-y-8">
    <section>
      <h2 className="u-caps text-[11px]">Method</h2>
      <p className="u-label mt-2 text-[16px] leading-relaxed">
        Channels are not compared by their tips. They are compared by their overpay against a
        reference — what it cost to land in that same slot for someone who was not overpaying. A
        channel with a higher average tip is not automatically worse; it may simply serve busier
        slots. Overpay removes that excuse.
      </p>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">
          How a figure on the board is produced
        </h3>
      </div>
      <ol className="border-t border-[hsl(var(--rule))]">
        {STEPS.map((s, i) => (
          <li key={s} className="flex gap-4 border-b border-[hsl(var(--grid-minor))] py-3">
            <span className="u-num shrink-0 text-[12px] text-[hsl(var(--ink-muted))]">{i + 1}</span>
            <span className="u-label text-[15px] leading-relaxed">{s}</span>
          </li>
        ))}
      </ol>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">Worked example</h3>
        <Marker />
      </div>
      <p className="u-label text-[15px] leading-relaxed">
        The routed transaction from Side by side: it landed in slot {RUN_ROUTED.slot} paying{' '}
        {fmtInt(RUN_ROUTED.baseFee)} base fee and {fmtInt(RUN_ROUTED.priorityFee)} priority fee,
        with no tip. The tenth percentile of total cost in that slot was{' '}
        {fmtInt(REFERENCE_LAMPORTS)}.
      </p>
      <p className="u-num mt-3 border-y border-[hsl(var(--rule))] py-3 text-[15px]">
        {fmtInt(RUN_ROUTED.total)} − {fmtInt(REFERENCE_LAMPORTS)} ={' '}
        {fmtInt(RUN_ROUTED.total - REFERENCE_LAMPORTS)} lamports overpay
      </p>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">Limits</h3>
      </div>
      <ul className="border-t border-[hsl(var(--rule))]">
        <li className="u-label border-b border-[hsl(var(--grid-minor))] py-3 text-[15px] leading-relaxed">
          Services that share the same service accounts cannot be told apart on-chain, so they are
          shown as one group and never guessed at individually.
        </li>
        <li className="u-label border-b border-[hsl(var(--grid-minor))] py-3 text-[15px] leading-relaxed">
          Checking a figure by hand is only possible for the last 48 hours; beyond that only hourly
          aggregates are kept.
        </li>
      </ul>
    </section>

    <section>
      <div className="flex flex-wrap items-center gap-2">
        <p className="u-label text-[13px] text-[hsl(var(--ink-muted))]">
          Every figure in this interface is synthetic and every delivery service named here is
          invented. Only the network, Solana, is real.
        </p>
        <Marker />
      </div>
    </section>
  </div>
)

export default Method
