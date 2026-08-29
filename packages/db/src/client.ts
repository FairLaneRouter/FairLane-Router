import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DatabaseOptions = {
  /** Стеля з'єднань на процес. Пул спільний на весь Supabase-проект. */
  readonly max?: number
}

export type DatabaseHandle = {
  readonly db: ReturnType<typeof drizzle<typeof schema>>
  close(): Promise<void>
}

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
