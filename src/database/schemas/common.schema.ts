import * as t from 'drizzle-orm/sqlite-core'

/** Creates a custom SQLite column builder for a generic enum type stored as text in the database. */
export const customEnum = <T>(name: string) =>
  t.customType<{
    data: T
  }>({
    /** Returns the data type. */
    dataType() {
      return 'text'
    },
  })(name)
