import * as t from 'drizzle-orm/sqlite-core'

/** Declares a custom enumeration type for use with SQLite, specifying the name of the enumeration. */
export const customEnum = <T>(name: string) =>
  t.customType<{
    data: T
  }>({
    /** Returns the data type identifier for text data. */
    dataType() {
      return 'text'
    },
  })(name)
