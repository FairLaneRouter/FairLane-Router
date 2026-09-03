import Marker from '@/components/Marker'
import {
  AGGREGATE_LEVEL_DAYS,
  BASE_FEE_PER_SIGNATURE,
  MIN_SLOT_REF_SAMPLES,
  SLOT_REF_PERCENTILE,
  TRANSACTION_LEVEL_HOURS,
} from '@/lib/method'
import { fmtInt, REFERENCE_LAMPORTS, RUN_ROUTED } from '@/lib/mock'

const FORMULA = [
  {
    term: 'total landing cost',
    body: `base fee + priority fee + every tip paid inside the same transaction to a service account this dashboard knows. The base fee is ${fmtInt(
      BASE_FEE_PER_SIGNATURE,
    )} lamports per signature; the priority fee is whatever the network fee exceeds that by, and is never reported as negative. A tip is not part of the network fee and never appears in it — it arrives as an ordinary transfer, so it is read as the balance increase of a service account within that transaction.`,
  },
  {
    term: 'slot reference',
    body: `the ${SLOT_REF_PERCENTILE}th percentile of total landing cost among the successful non-vote transactions of that one slot. It answers a single question: what did it cost to get into this slot for someone who was not overpaying.`,
  },
  {
    term: 'overpay',
    body: 'total landing cost of the transaction − the reference of the slot it landed in. It can be negative: landing for less than the tenth percentile is not an error, it is the nine percent below it.',
  },
]

const BY_HAND = [
  'Open the block in any explorer and take its transactions.',
  'Discard vote transactions, and discard the ones that failed. Both are excluded everywhere below.',
  `If fewer than ${MIN_SLOT_REF_SAMPLES} transactions remain, this slot has no reference at all, and no landing in it carries an overpay figure. Stop here.`,
  'For each remaining transaction, add up its total landing cost as defined above.',
  `Sort those totals from cheapest to dearest and take the one at position ceil(${(
    SLOT_REF_PERCENTILE / 100
  ).toFixed(2)} × count), counting from one. That value is the slot reference — an amount someone actually paid, not an average of two neighbours.`,
  'Subtract the reference from the total cost of the transaction you started with.',
]

const ATTRIBUTION = [
  {
    when: 'it tipped a service account of one known group',
    counted: 'it belongs to that group',
  },
  {
    when: 'it tipped service accounts of two different groups at once',
    counted: 'it is left unattributed — picking the larger transfer would be a guess',
  },
  {
    when: 'it tipped no known service account but paid a priority fee',
    counted: 'it is counted as plain RPC',
  },
  {
    when: 'it paid neither a tip nor a priority fee',
    counted: 'it bought no delivery, and is left unattributed',
  },
]

const LIMITS = [
  `Checking a figure by hand is only possible while the transaction itself is still stored — the last ${TRANSACTION_LEVEL_HOURS} hours. Beyond that only hourly aggregates remain, for ${AGGREGATE_LEVEL_DAYS} days, and a single transaction can no longer be recomputed from them.`,
  'Services that accept tips on the same service accounts cannot be told apart on-chain. They are shown as one group, and the brand inside a group is never guessed at — not from the size of the tip, not from the shape of the bundle, not from the position in the block. What is measured is the cost of a path, not of a brand.',
  'Being visible here and being available to send through are two different things. A channel whose service accounts are on-chain is measured whether or not this dashboard can send anything through it.',
  'Two of the services hand out private service accounts to high-volume clients, and those are not published anywhere. A transaction that tips one of them is indistinguishable on-chain from an ordinary transfer, so it is counted as unattributed. What a group shows here is therefore a lower bound on its traffic, never an overstatement.',
  'The unattributed share is published next to the figures rather than hidden inside them. A transaction that cannot be assigned to a group is never assigned to the nearest one.',
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
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">Three definitions</h3>
      </div>
      <dl className="border-t border-[hsl(var(--rule))]">
        {FORMULA.map((item) => (
          <div key={item.term} className="border-b border-[hsl(var(--grid-minor))] py-3">
            <dt className="u-caps text-[10px]">{item.term}</dt>
            <dd className="u-label mt-1 text-[15px] leading-relaxed">{item.body}</dd>
          </div>
        ))}
      </dl>
      <p className="u-label mt-3 text-[14px] leading-relaxed text-[hsl(var(--ink-muted))]">
        Vote transactions are excluded from the reference always. They are the majority of a block
        and pay only the base fee; counted in, they would drag the reference to nearly zero and the
        whole price of delivery would show up as overpay.
      </p>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">
          Recomputing one figure by hand
        </h3>
      </div>
      <ol className="border-t border-[hsl(var(--rule))]">
        {BY_HAND.map((step, i) => (
          <li key={step} className="flex gap-4 border-b border-[hsl(var(--grid-minor))] py-3">
            <span className="u-num shrink-0 text-[12px] text-[hsl(var(--ink-muted))]">{i + 1}</span>
            <span className="u-label text-[15px] leading-relaxed">{step}</span>
          </li>
        ))}
      </ol>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">
          Which group a transaction is counted under
        </h3>
      </div>
      <dl className="border-t border-[hsl(var(--rule))]">
        {ATTRIBUTION.map((rule) => (
          <div
            key={rule.when}
            className="flex flex-col gap-1 border-b border-[hsl(var(--grid-minor))] py-3 sm:flex-row sm:gap-4"
          >
            <dt className="u-label text-[15px] leading-relaxed sm:w-[52%]">If {rule.when},</dt>
            <dd className="u-label text-[15px] leading-relaxed text-[hsl(var(--ink-muted))] sm:flex-1">
              {rule.counted}.
            </dd>
          </div>
        ))}
      </dl>
    </section>

    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h3 className="u-caps text-[10px] text-[hsl(var(--ink-muted))]">Worked example</h3>
        <Marker />
      </div>
      <p className="u-label text-[15px] leading-relaxed">
        The routed transaction from Side by side: it landed in slot {RUN_ROUTED.slot} paying{' '}
        {fmtInt(RUN_ROUTED.baseFee)} base fee and {fmtInt(RUN_ROUTED.priorityFee)} priority fee,
        with no tip. The {SLOT_REF_PERCENTILE}th percentile of total cost in that slot was{' '}
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
        {LIMITS.map((limit) => (
          <li
            key={limit}
            className="u-label border-b border-[hsl(var(--grid-minor))] py-3 text-[15px] leading-relaxed"
          >
            {limit}
          </li>
        ))}
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
