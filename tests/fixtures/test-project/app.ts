import { add, Calculator } from './math'

export function runCalculation(x: number, y: number): number {
  if (!process.env.APP_TOKEN) {
    throw new TypeError('Missing token')
  }

  const calc = new Calculator()
  const prod = calc.multiply(x, y)
  return add(prod, 10)
}
