import { describe, expect, test } from 'bun:test'
import { ImplementsStatic } from '../src/utils/ImplementsStaticDecorator'

interface FactoryStatics {
  new (): { greet(): string }
  create(name: string): string
}

describe('ImplementsStatic', () => {
  test('returns the same class reference unchanged (pure passthrough)', () => {
    @ImplementsStatic<FactoryStatics>()
    class Greeter {
      greet() {
        return 'hi'
      }
      static create(name: string) {
        return `created:${name}`
      }
    }

    const decorated = ImplementsStatic<FactoryStatics>()(Greeter)
    expect(decorated).toBe(Greeter)
  })

  test('decorated class remains fully functional: instances and statics both work', () => {
    @ImplementsStatic<FactoryStatics>()
    class Greeter {
      greet() {
        return 'hello'
      }
      static create(name: string) {
        return `created:${name}`
      }
    }

    expect(new Greeter().greet()).toBe('hello')
    expect(Greeter.create('bob')).toBe('created:bob')
  })

  test('can be applied directly as a function without decorator syntax', () => {
    class Plain {
      static create(name: string) {
        return name
      }
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
    class NumberParser {
      static parse(input: string) {
        return Number(input)
      }
    }

    expect(NumberParser.parse('42')).toBe(42)
  })
})
