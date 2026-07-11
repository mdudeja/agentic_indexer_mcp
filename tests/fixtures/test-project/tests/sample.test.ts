import { Calculator, Direction, MathUtils } from '../math'
import { runCalculation, Service } from '../app'
import { describe, expect, it } from 'bun:test'

const calc = new Calculator()

describe('Sample Tests', () => {
  it('should multiply two numbers correctly', () => {
    const result = calc.multiply(2, 3)
    expect(result).toBe(6)
  })

  it('MathUtils should be defined', () => {
    expect(MathUtils).toBeDefined()
  })

  it('Direction should be defined', () => {
    expect(Direction).toBeDefined()
  })

  it('runCalculation throw when called without setting token', () => {
    const result = () => runCalculation(4, 5)
    expect(result).toThrow()
  })

  it('Service should be defined', () => {
    expect(Service).toBeDefined()
  })
})
