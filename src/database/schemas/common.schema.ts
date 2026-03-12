import * as t from 'drizzle-orm/sqlite-core'

export const customEnum = <T>(name: string) =>
  t.customType<{
    data: T
  }>({
    dataType() {
      return 'text'
    },
  })(name)
