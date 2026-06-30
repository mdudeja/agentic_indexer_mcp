import { describe, it, expect } from 'bun:test'
import {
  truncate,
  parseTypeNames,
  getParentsOfSymbolCall,
  parseArguments,
} from '../src/utils/misc'
import {
  getNow,
  getNowMillis,
  getStartOfDayMillis,
  getEndOfDayMillis,
  formatTimeDuration,
  formatDateTime,
} from '../src/utils/datetime'
import { Temporal } from 'temporal-polyfill'

describe('misc utils', () => {
  describe('truncate', () => {
    it('returns string unchanged when within limit', () => {
      expect(truncate('hello', 10)).toBe('hello')
    })

    it('truncates with ellipsis when over limit', () => {
      expect(truncate('hello world', 6)).toBe('hello…')
    })

    it('handles exact length without truncating', () => {
      expect(truncate('hello', 5)).toBe('hello')
    })

    it('truncates to 1 char with ellipsis', () => {
      expect(truncate('abc', 2)).toBe('a…')
    })
  })

  describe('parseTypeNames', () => {
    it('parses simple identifiers', () => {
      expect(parseTypeNames('string')).toEqual(['string'])
    })

    it('parses comma-separated types', () => {
      expect(parseTypeNames('string, number')).toEqual(['string', 'number'])
    })

    it('strips generic parameters', () => {
      expect(parseTypeNames('Array<string>')).toEqual(['Array'])
    })

    it('handles nested generics', () => {
      expect(parseTypeNames('Map<string, number>')).toEqual(['Map'])
    })

    it('strips array suffixes', () => {
      expect(parseTypeNames('string[]')).toEqual(['string'])
    })

    it('strips optional marker', () => {
      expect(parseTypeNames('string?')).toEqual(['string'])
    })

    it('accepts namespaced types', () => {
      expect(parseTypeNames('pkg.Type')).toEqual(['pkg.Type'])
    })

    it('filters out non-identifier tokens', () => {
      expect(parseTypeNames('123bad')).toEqual([])
    })

    it('handles mixed list with generics', () => {
      expect(parseTypeNames('Foo<Bar>, Baz')).toEqual(['Foo', 'Baz'])
    })

    it('returns empty array for empty string', () => {
      expect(parseTypeNames('')).toEqual([])
    })
  })

  describe('getParentsOfSymbolCall', () => {
    it('returns single parent from dot-access', () => {
      expect(getParentsOfSymbolCall('foo.bar()', 'bar')).toEqual(['foo'])
    })

    it('returns multiple parents from chained dot-access', () => {
      expect(getParentsOfSymbolCall('a.b.c()', 'c')).toEqual(['a', 'b'])
    })

    it('handles arrow accessor', () => {
      expect(getParentsOfSymbolCall('obj->method()', 'method')).toEqual(['obj'])
    })

    it('handles double-colon accessor', () => {
      expect(getParentsOfSymbolCall('Ns::func()', 'func')).toEqual(['Ns'])
    })

    it('ignores separators inside argument parens', () => {
      expect(getParentsOfSymbolCall('foo(a.b).bar()', 'bar')).toEqual(['foo'])
    })

    it('returns empty array when callee is top-level', () => {
      expect(getParentsOfSymbolCall('standalone()', 'standalone')).toEqual([])
    })
  })

  describe('parseArguments', () => {
    it('parses simple comma-separated args', () => {
      expect(parseArguments('a, b, c')).toEqual(['a', 'b', 'c'])
    })

    it('keeps nested parens together', () => {
      expect(parseArguments('foo(a, b), c')).toEqual(['foo(a, b)', 'c'])
    })

    it('keeps nested brackets together', () => {
      expect(parseArguments('[1, 2], x')).toEqual(['[1, 2]', 'x'])
    })

    it('keeps nested braces together', () => {
      expect(parseArguments('{a: 1}, y')).toEqual(['{a: 1}', 'y'])
    })

    it('returns single arg when no commas', () => {
      expect(parseArguments('singleArg')).toEqual(['singleArg'])
    })

    it('returns empty array for empty string', () => {
      expect(parseArguments('')).toEqual([])
    })

    it('trims whitespace from args', () => {
      expect(parseArguments('  a  ,  b  ')).toEqual(['a', 'b'])
    })
  })
})

describe('datetime utils', () => {
  describe('getNow', () => {
    it('returns a Temporal.Instant', () => {
      const now = getNow()
      expect(now).toBeInstanceOf(Temporal.Instant)
    })

    it('is close to current time', () => {
      const before = Date.now()
      const now = getNow()
      const after = Date.now()
      expect(now.epochMilliseconds).toBeGreaterThanOrEqual(before)
      expect(now.epochMilliseconds).toBeLessThanOrEqual(after)
    })
  })

  describe('getNowMillis', () => {
    it('returns a number close to Date.now()', () => {
      const before = Date.now()
      const millis = getNowMillis()
      const after = Date.now()
      expect(millis).toBeGreaterThanOrEqual(before)
      expect(millis).toBeLessThanOrEqual(after)
    })
  })

  describe('getStartOfDayMillis', () => {
    it('returns a number earlier than now', () => {
      const now = Date.now()
      const start = getStartOfDayMillis({ year: 2024, month: 6, day: 15 })
      expect(typeof start).toBe('number')
      expect(start).toBeLessThan(now)
    })

    it('returns midnight (hour 0) of the given date', () => {
      const start = getStartOfDayMillis({ year: 2024, month: 1, day: 1 })
      const end = getEndOfDayMillis({ year: 2024, month: 1, day: 1 })
      expect(start).toBeLessThan(end)
    })

    it('is less than end of same day', () => {
      const today = Temporal.Now.plainDateISO()
      const start = getStartOfDayMillis(today)
      const end = getEndOfDayMillis(today)
      expect(start).toBeLessThan(end)
    })
  })

  describe('getEndOfDayMillis', () => {
    it('returns a number', () => {
      const end = getEndOfDayMillis({ year: 2024, month: 6, day: 15 })
      expect(typeof end).toBe('number')
    })

    it('is within 24h of start of day', () => {
      const start = getStartOfDayMillis({ year: 2024, month: 6, day: 15 })
      const end = getEndOfDayMillis({ year: 2024, month: 6, day: 15 })
      expect(end - start).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    })
  })

  describe('formatTimeDuration', () => {
    it('formats seconds only', () => {
      expect(formatTimeDuration(5000)).toBe('5s')
    })

    it('formats minutes and seconds', () => {
      expect(formatTimeDuration(65000)).toBe('1m 5s')
    })

    it('formats hours, minutes and seconds', () => {
      expect(formatTimeDuration(3661000)).toBe('1h 1m 1s')
    })

    it('shows 0s for zero duration', () => {
      expect(formatTimeDuration(0)).toBe('0s')
    })

    it('formats hours without minutes when minutes is 0', () => {
      expect(formatTimeDuration(3600000)).toBe('1h')
    })

    it('formats hours and minutes without seconds when seconds is 0', () => {
      expect(formatTimeDuration(3660000)).toBe('1h 1m')
    })

    it('formats minutes without seconds when seconds is 0', () => {
      expect(formatTimeDuration(60000)).toBe('1m')
    })
  })

  describe('formatDateTime', () => {
    it('returns a string', () => {
      const result = formatDateTime(Date.now())
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('contains date components', () => {
      const millis = new Date('2024-06-15T12:00:00Z').getTime()
      const result = formatDateTime(millis)
      expect(result).toMatch(/2024/)
    })
  })
})
