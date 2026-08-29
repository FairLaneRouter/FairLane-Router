import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  // Пряме з'єднання: генерація SQL його не торкається, а `drizzle-kit push`
  // і `check` — торкаються, і повз пулер вони мають ходити так само.
  dbCredentials: { url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
