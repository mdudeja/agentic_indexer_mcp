import * as t from 'drizzle-orm/sqlite-core'

export enum InheritenceType {
  extends = 'extends',
  implements = 'implements',
  union = 'union',
  intersection = 'intersection',
}

/** Creates a custom SQLite column type for defining enums, ensuring proper handling of enum-like data in database interactions. */
export const customEnum = <T>(name: string) =>
  t.customType<{
    data: T
  }>({
    /** Returns the data type identifier for text data. */
    dataType() {
      return 'text'
    },
  })(name)

export type Inheritence = {
  inherits_from_name: string
  inherits_from_id?: string
  inherits_from_imports_id?: string
  inheritence_type: InheritenceType
}
