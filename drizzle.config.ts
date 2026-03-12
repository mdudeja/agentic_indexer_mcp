import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/database/schemas/*.schema.ts',
  out: './drizzle_migrations',
  dialect: 'sqlite',

  migrations: {
    table: '__drizzle_migrations__',
  },

  strict: true,
  verbose: true,
  breakpoints: true,
})
