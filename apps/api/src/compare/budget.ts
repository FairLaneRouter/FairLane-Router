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
 * When the run is over, `settle` gives back what it did not spend. If the
 * process dies in between, the reservation simply stays: the budget errs on
 * the side of spending less, never more.
 */
export type DemoBudget = {
  /**
   * Takes `amountLamports` out of today's budget, or nothing at all.
   * `undefined` means the day has no room for it (FR-036: the run must not start).
   */
  reserve(amountLamports: bigint, at: Date): Promise<Reservation | undefined>
  /**
   * Replaces the reservation with what the run really cost, on the day the
   * reservation was made — a run that crosses midnight is still yesterday's.
   * Returns the day's spend after settling.
   */
  settle(reservation: Reservation, actualLamports: bigint): Promise<bigint>
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

export type BudgetLimits = {
  readonly dailyLamports: bigint
}

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

export function createDemoBudget(db: Database, limits: BudgetLimits): DemoBudget {
  if (limits.dailyLamports < 0n) {
    throw new DemoBudgetError('the daily limit cannot be negative')
  }

  return {
    async reserve(amountLamports, at) {
      if (amountLamports <= 0n) {
        throw new DemoBudgetError('a reservation must be a positive number of lamports')
      }
      // Not a race: both sides are constants of this call, not state.
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

      return row.spentLamports
    },
  }
}
