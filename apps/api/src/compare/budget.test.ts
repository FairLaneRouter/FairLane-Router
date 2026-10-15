import { createDatabase } from '@fairlane/db'
import { afterAll, describe, expect, it } from 'vitest'
import {
  budgetDay,
  createDemoBudget,
  DemoBudgetError,
  type Reservation,
  reserveStatement,
  settleStatement,
} from './budget.ts'

// Nothing listens on port 1: a call that reaches the database fails with a
// connection error, so a test that resolves cleanly proves it never got there.
const handle = createDatabase('postgres://nobody@127.0.0.1:1/unused')

afterAll(() => handle.close())

const DAY = '2026-10-15'
const AT = new Date('2026-10-15T12:00:00.000Z')

describe('budgetDay', () => {
  it('is the UTC date', () => {
    expect(budgetDay(AT)).toBe(DAY)
  })

  it('turns over at UTC midnight, not at local midnight', () => {
    expect(budgetDay(new Date('2026-10-15T23:59:59.999Z'))).toBe('2026-10-15')
    expect(budgetDay(new Date('2026-10-16T00:00:00.000Z'))).toBe('2026-10-16')
  })
})

describe('reserveStatement', () => {
  const query = reserveStatement(handle.db, {
    day: DAY,
    amountLamports: 2_000_000n,
    dailyLamports: 50_000_000n,
  }).toSQL()

  it('checks and debits in one statement', () => {
    expect(query.sql).toMatch(/^insert into "demo_budget"/i)
    expect(query.sql).toMatch(/on conflict \("day"\) do update set/i)
    expect(query.sql).toMatch(/returning "spent_lamports", "runs_count"$/i)
  })

  it('keeps the limit in the database, in the update condition', () => {
    const where = query.sql.slice(query.sql.search(/ where /i))
    expect(where).toMatch(/"spent_lamports" \+ \$\d+ <= \$\d+/)
  })

  it('adds to the stored spend rather than overwriting it', () => {
    expect(query.sql).toMatch(/set "spent_lamports" = "demo_budget"\."spent_lamports" \+ \$\d+/i)
    expect(query.sql).toMatch(/"runs_count" = "demo_budget"\."runs_count" \+ 1/i)
  })

  it('passes money as bigint parameters, never as text in the SQL', () => {
    expect(query.params).toContain(2_000_000n)
    expect(query.params).toContain(50_000_000n)
    expect(query.sql).not.toContain('2000000')
    expect(query.sql).not.toContain('50000000')
  })
})

describe('settleStatement', () => {
  const query = settleStatement(handle.db, {
    day: DAY,
    reservedLamports: 2_000_000n,
    actualLamports: 31_250n,
  }).toSQL()

  it('swaps the reservation for the real cost on the reservation day', () => {
    expect(query.sql).toMatch(/^update "demo_budget" set "spent_lamports" = /i)
    expect(query.sql).toMatch(/"spent_lamports" - \$\d+ \+ \$\d+/)
    expect(query.sql).toMatch(/"day" = \$\d+/)
    expect(query.params).toEqual(expect.arrayContaining([DAY, 2_000_000n, 31_250n]))
  })

  it('does not touch the run counter — a settled run was still a run', () => {
    expect(query.sql).not.toContain('runs_count')
  })

  it('has no limit condition: a fact about spent money is never refused', () => {
    expect(query.sql).not.toContain('<=')
  })
})

describe('createDemoBudget', () => {
  const budget = createDemoBudget(handle.db, { dailyLamports: 50_000_000n })

  it('refuses an amount above the daily limit without asking the database', async () => {
    await expect(budget.reserve(50_000_001n, AT)).resolves.toBeUndefined()
  })

  it('reaches the database for an amount within the limit', async () => {
    // The control for the test above: same budget, same handle, but this
    // call does get to the dead port — so "resolves cleanly" there means
    // something.
    await expect(budget.reserve(50_000_000n, AT)).rejects.not.toBeInstanceOf(DemoBudgetError)
  })

  it.each([0n, -1n])('rejects a reservation of %s lamports', async (amount) => {
    await expect(budget.reserve(amount, AT)).rejects.toBeInstanceOf(DemoBudgetError)
  })

  it('rejects a negative cost', async () => {
    const reservation: Reservation = {
      day: DAY,
      reservedLamports: 2_000_000n,
      spentLamports: 2_000_000n,
      runsCount: 1,
    }
    await expect(budget.settle(reservation, -1n)).rejects.toBeInstanceOf(DemoBudgetError)
  })

  it('rejects a negative daily limit', () => {
    expect(() => createDemoBudget(handle.db, { dailyLamports: -1n })).toThrow(DemoBudgetError)
  })
})
