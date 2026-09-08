import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

export type DatabaseOptions = {
  /** Стеля з'єднань на процес. Пул спільний на весь Supabase-проект. */
  readonly max?: number
}

export type DatabaseHandle = {
  readonly db: Database
  close(): Promise<void>
}

/** З'єднання без права його закрити — саме це приймають сховища в `apps/*`. */
export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * З'єднання йде через pgbouncer у режимі транзакцій (Supabase, порт 6543).
 * Звідси `prepare: false`: підготовлені вирази живуть у сеансі, а сеанс за
 * пулером не належить нам між транзакціями — з ними запити почали б падати
 * випадково, під навантаженням і не відразу.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): DatabaseHandle {
  const sql = postgres(url, {
    prepare: false,
    max: options.max ?? 5,
    onnotice: () => {},
  })

  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end(),
  }
}
