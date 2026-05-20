import { Temporal } from 'temporal-polyfill'

/** Returns the current system time as a Temporal.Instant. */
const getNow = (): Temporal.Instant => {
  return Temporal.Now.instant()
}

/** Returns the current time in milliseconds since the Unix epoch. */
const getNowMillis = (): number => {
  return Temporal.Now.instant().epochMilliseconds
}

/** Returns the epoch milliseconds for the start of the day of the given date in the current system time zone. */
const getStartOfDayMillis = (date: Temporal.PlainDateLike): number => {
  const plainDate = Temporal.PlainDate.from(date)
  const startOfDay = plainDate.toPlainDateTime({
    hour: 0,
    minute: 0,
    second: 0,
  })
  const zonedDateTime = startOfDay.toZonedDateTime(Temporal.Now.timeZoneId())
  return zonedDateTime.toInstant().epochMilliseconds
}

/** Calculates the epoch milliseconds for the end of the day (23:59:59.999) for a given date in the system current time zone. */
const getEndOfDayMillis = (date: Temporal.PlainDateLike): number => {
  const plainDate = Temporal.PlainDate.from(date)
  const endOfDay = plainDate.toPlainDateTime({
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  })
  const zonedDateTime = endOfDay.toZonedDateTime(Temporal.Now.timeZoneId())
  return zonedDateTime.toInstant().epochMilliseconds
}

/** Converts a duration in milliseconds to a formatted string of hours, minutes, and seconds. */
const formatTimeDuration = (durationMs: number): string => {
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)

  return parts.join(' ')
}

/** Converts epoch milliseconds to a local ISO date-time string without fractional seconds. */
const formatDateTime = (millis: number): string => {
  const instant = Temporal.Instant.fromEpochMilliseconds(millis)
  const zonedDateTime = instant.toZonedDateTimeISO(Temporal.Now.timeZoneId())
  return zonedDateTime.toString({ fractionalSecondDigits: 0 })
}

export {
  getNow,
  getNowMillis,
  getStartOfDayMillis,
  getEndOfDayMillis,
  formatTimeDuration,
  formatDateTime,
}
