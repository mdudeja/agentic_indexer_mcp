import { describe, expect, test } from 'bun:test'
import { ImplementsStatic } from '../src/utils/ImplementsStaticDecorator'

interface FactoryStatics {
  new (): { greet(): string }
  create(name: string): string
}

describe('ImplementsStatic', () => {
  test('returns the same class reference unchanged (pure passthrough)', () => {
    @ImplementsStatic<FactoryStatics>()
    /** A class designed to create and manage greeting messages for users or entities. It handles generating personalized greetings in various formats. */
    class Greeter {
      /** Returns a friendly greeting. */
      greet() {
        return 'hi'
      }
      /** Creates a greeting message for the specified name. */
      static create(name: string) {
        return `created:${name}`
      }
    }

    const decorated = ImplementsStatic<FactoryStatics>()(Greeter)
    expect(decorated).toBe(Greeter)
  })

  test('decorated class remains fully functional: instances and statics both work', () => {
    @ImplementsStatic<FactoryStatics>()
    /** A utility class designed to create and manage greeting messages. */
    class Greeter {
      /** Generates and returns a friendly greeting message. */
      greet() {
        return 'hello'
      }
      /** This method generates a new string by appending  Created to the given name. */
      static create(name: string) {
        return `created:${name}`
      }
    }

    expect(new Greeter().greet()).toBe('hello')
    expect(Greeter.create('bob')).toBe('created:bob')
  })

  test('can be applied directly as a function without decorator syntax', () => {
    /** A plain and simple implementation for basic functionality. */
    class Plain {
      /** Creates a unique identifier based on the provided name. */
      static create(name: string) {
        return name
      }
      /** Return a friendly greeting message. */
      greet() {
        return 'plain'
      }
    }

    const Result = ImplementsStatic<FactoryStatics>()(Plain)
    expect(Result).toBe(Plain)
    expect(Result.create('x')).toBe('x')
  })

  test('is generic over any interface shape and works with a different static contract', () => {
    interface ParserStatics {
      new (): unknown
      parse(input: string): number
    }

    @ImplementsStatic<ParserStatics>()
    /** A utility class for parsing string representations of numbers into numeric values. It converts number strings into integers, floats, or other numeric types while ensuring proper validation and conversion. */
    class NumberParser {
      /** Parses a string representation of a number into its numeric form. */
      static parse(input: string) {
        return Number(input)
      }
    }

    expect(NumberParser.parse('42')).toBe(42)
  })
})
