import * as t from 'drizzle-orm/sqlite-core'

export enum InheritenceType {
  extends = 'extends',
  implements = 'implements',
  union = 'union',
  intersection = 'intersection',
}

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

export const inheritenceSchema = {
  inherits_from_names: t.text(),
  inheritence_type: customEnum<InheritenceType>('inheritence_type'),
}
