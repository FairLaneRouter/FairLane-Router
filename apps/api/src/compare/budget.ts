import { type Database, demoBudget } from '@fairlane/db'
import { and, eq, gte, sql } from 'drizzle-orm'

/**
 * The demo wallet's daily budget (FR-036, SC-011).
 *
 * A run cannot be charged after the fact: by the time its cost is known, both
 * transactions are already on chain, and two runs that each read "there is
 * room" and then spent would go past the limit together. So the money is
 * taken **before** anything is sent, as a reservation of the run's ceiling,
 * and the check and the debit are one statement — Postgres holds the row lock
 * between them, so there is no window a parallel run could slip through.
 *
 * What is reserved is always the per-run limit, never an amount the caller
 * picks: the pair of transactions has to fit under it (T052), and the number
 * of runs left (FR-037) is then exactly the number of reservations the day and
 * the wallet still admit.
 *
 * When the run is over, `settle` gives back what it did not spend. If the
 * process dies in between, the reservation simply stays: the budget errs on
 * the side of spending less, never more.
 */
export type DemoBudget = {
  /** The ceiling of one run — what a pair of transactions must fit under. */
  readonly perRunLamports: bigint
  /**
   * Takes the per-run limit out of today's budget, or nothing at all.
   * `undefined` means the day has no room for one more run (FR-036: the run
   * must not start).
   */
  reserve(at: Date): Promise<Reservation | undefined>
  /**
   * Replaces the reservation with what the run really cost, on the day the
   * reservation was made — a run that crosses midnight is still yesterday's.
   */
  settle(reservation: Reservation, actualLamports: bigint): Promise<Settlement>
  /** Today's spend, the wallet's balance and the runs both still allow (FR-037). */
  status(at: Date): Promise<BudgetStatus>
}

export type Reservation = {
  /** UTC day, `YYYY-MM-DD` — the key of the `demo_budget` row. */
  readonly day: string
  readonly reservedLamports: bigint
  /** The day's spend right after this reservation, the reservation included. */
  readonly spentLamports: bigint
  /** Runs started on that day, this one included. */
  readonly runsCount: number
}

export type Settlement = {
  /** The day's spend after settling. */
  readonly spentLamports: bigint
  /**
   * The run cost more than its reservation. The money is spent all the same
   * and is written as spent; this is the signal that the pair outgrew the
   * per-run limit and the limit no longer bounds a run.
   */
  readonly overrun: boolean
}

export type BudgetLimits = {
  readonly dailyLamports: bigint
  readonly perRunLamports: bigint
}

export type BudgetStatus = {
  /** UTC day the status is for. */
  readonly day: string
  readonly dailyLamports: bigint
  readonly perRunLamports: bigint
  /** Spent and reserved today, runs in flight included. */
  readonly spentLamports: bigint
  /** `null` when the balance could not be read. */
  readonly balanceLamports: bigint | null
  /**
   * The least number of runs that will still be let through. A lower bound:
   * a run reserves the full per-run limit and usually spends a small part of
   * it, so settling gives room back. `null` with an unknown balance — a count
   * from the day alone could promise runs the wallet cannot pay for.
   */
  readonly runsLeft: number | null
  /** What runs out first, `null` when `runsLeft` is. */
  readonly limitedBy: 'day' | 'balance' | null
}

/**
 * A fee payer must stay rent-exempt after every transaction it pays for, or
 * the transaction fails: the minimum for an account with no data (890 880
 * lamports, `getMinimumBalanceForRentExemption(0)`) is never spendable.
 */
export const RENT_EXEMPT_MINIMUM_LAMPORTS = 890_880n

/** A caller's mistake, not an exhausted budget — those come back as `undefined`. */
export class DemoBudgetError extends Error {
  override name = 'DemoBudgetError'
}

/** The budget's day: UTC, like every other grid in the system. */
export function budgetDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

type ReserveInput = {
  readonly day: string
  readonly amountLamports: bigint
  readonly dailyLamports: bigint
}

/**
 * Exported so a test can read its SQL: the limit lives in the text of this
 * statement, and there is no Postgres in the gate to catch a refactor that
 * moves the check into the process.
 *
 * The first run of a day inserts the row, every later one goes through
 * `on conflict`. The insert branch has no condition of its own — `reserve`
 * refuses an amount above the daily limit before it gets here, and a fresh
 * row starts from zero.
 */
export function reserveStatement(db: Database, input: ReserveInput) {
  return db
    .insert(demoBudget)
    .values({ day: input.day, spentLamports: input.amountLamports, runsCount: 1 })
    .onConflictDoUpdate({
      target: demoBudget.day,
      set: {
        spentLamports: sql`${demoBudget.spentLamports} + ${input.amountLamports}`,
        runsCount: sql`${demoBudget.runsCount} + 1`,
      },
      setWhere: sql`${demoBudget.spentLamports} + ${input.amountLamports} <= ${input.dailyLamports}`,
    })
    .returning({ spentLamports: demoBudget.spentLamports, runsCount: demoBudget.runsCount })
}

type SettleInput = {
  readonly day: string
  readonly reservedLamports: bigint
  readonly actualLamports: bigint
}

/**
 * No limit here, on purpose. The limit was enforced when the money was
 * reserved; what settling writes is a fact about money already spent, and a
 * ledger that refused a fact would only hide an overrun from SC-011.
 *
 * `spent >= reserved` keeps the row from going below zero when a reservation
 * is settled against a day that never held it. It does not make settling
 * idempotent: on a busy day a second settle of the same run would pass. One
 * settle per run is the runner's contract (T053), which owns the run's row.
 */
export function settleStatement(db: Database, input: SettleInput) {
  return db
    .update(demoBudget)
    .set({
      spentLamports: sql`${demoBudget.spentLamports} - ${input.reservedLamports} + ${input.actualLamports}`,
    })
    .where(
      and(eq(demoBudget.day, input.day), gte(demoBudget.spentLamports, input.reservedLamports)),
    )
    .returning({ spentLamports: demoBudget.spentLamports })
}

export function spentStatement(db: Database, day: string) {
  return db
    .select({ spentLamports: demoBudget.spentLamports })
    .from(demoBudget)
    .where(eq(demoBudget.day, day))
}

type RunsLeftInput = {
  readonly dailyLamports: bigint
  readonly perRunLamports: bigint
  readonly spentLamports: bigint
  readonly balanceLamports: bigint
}

/**
 * How many more runs the day and the wallet both admit. On a tie the wallet
 * is named: an exhausted day comes back tomorrow, an empty wallet does not.
 */
export function runsLeft(input: RunsLeftInput): { runs: number; limitedBy: 'day' | 'balance' } {
  const room = input.dailyLamports - input.spentLamports
  const byDay = room > 0n ? room / input.perRunLamports : 0n
  const spendable = input.balanceLamports - RENT_EXEMPT_MINIMUM_LAMPORTS
  const byBalance = spendable > 0n ? spendable / input.perRunLamports : 0n

  return byBalance <= byDay
    ? { runs: Number(byBalance), limitedBy: 'balance' }
    : { runs: Number(byDay), limitedBy: 'day' }
}

/**
 * `readBalance` returns the demo wallet's lamports. It is the caller's
 * wiring (the wallet's address and an RPC client), not the budget's: the
 * budget keeps the ledger, the chain holds the money.
 */
export function createDemoBudget(
  db: Database,
  limits: BudgetLimits,
  readBalance: () => Promise<bigint>,
): DemoBudget {
  if (limits.dailyLamports < 0n) {
    throw new DemoBudgetError('the daily limit cannot be negative')
  }
  if (limits.perRunLamports <= 0n) {
    throw new DemoBudgetError('the per-run limit must be a positive number of lamports')
  }

  const amountLamports = limits.perRunLamports

  return {
    perRunLamports: amountLamports,

    async reserve(at) {
      // Not a race: both sides are constants of this budget, not state.
      if (amountLamports > limits.dailyLamports) return undefined

      const day = budgetDay(at)
      const rows = await reserveStatement(db, {
        day,
        amountLamports,
        dailyLamports: limits.dailyLamports,
      })

      const row = rows[0]
      if (row === undefined) return undefined

      return {
        day,
        reservedLamports: amountLamports,
        spentLamports: row.spentLamports,
        runsCount: row.runsCount,
      }
    },

    async settle(reservation, actualLamports) {
      if (actualLamports < 0n) {
        throw new DemoBudgetError('a run cannot cost a negative number of lamports')
      }

      const rows = await settleStatement(db, {
        day: reservation.day,
        reservedLamports: reservation.reservedLamports,
        actualLamports,
      })

      const row = rows[0]
      if (row === undefined) {
        throw new DemoBudgetError(`no reservation of this size to settle on ${reservation.day}`)
      }

      return {
        spentLamports: row.spentLamports,
        overrun: actualLamports > reservation.reservedLamports,
      }
    },

    async status(at) {
      const day = budgetDay(at)
      const [rows, balanceLamports] = await Promise.all([
        spentStatement(db, day),
        // A failed read is shown as an unknown balance, not as a broken page:
        // the day's spend is still worth showing.
        readBalance().catch(() => null),
      ])
      const spentLamports = rows[0]?.spentLamports ?? 0n
      const left =
        balanceLamports === null
          ? null
          : runsLeft({
              dailyLamports: limits.dailyLamports,
              perRunLamports: amountLamports,
              spentLamports,
              balanceLamports,
            })

      return {
        day,
        dailyLamports: limits.dailyLamports,
        perRunLamports: amountLamports,
        spentLamports,
        balanceLamports,
        runsLeft: left?.runs ?? null,
        limitedBy: left?.limitedBy ?? null,
      }
    },
  }
}
