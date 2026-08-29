import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '..', 'drizzle')

/**
 * Міграції йдуть **повз pgbouncer**, прямим з'єднанням (Supabase, порт 5432).
 * Пулер у режимі транзакцій роздає різні сеанси різним запитам, а міграція
 * тримає блокування й `CREATE TYPE`/`CREATE TABLE` в одній транзакції — за
 * пулером це ламається не завжди, а іноді, і саме тому найгірше.
 *
 * Одне з'єднання, і воно закривається: процес міграції має завершитись, а не
 * зависнути на живому пулі.
 */
export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL

  if (!url) {
    process.stderr.write('Немає DATABASE_DIRECT_URL і DATABASE_URL\n')
    process.exit(1)
  }

  if (!process.env.DATABASE_DIRECT_URL) {
    process.stderr.write(
      'DATABASE_DIRECT_URL не заданий — міграція піде через DATABASE_URL, ' +
        'тобто ймовірно через пулер. Для Supabase це порт 5432, не 6543.\n',
    )
  }

  await runMigrations(url)
  process.stdout.write('Міграції застосовані\n')
}
