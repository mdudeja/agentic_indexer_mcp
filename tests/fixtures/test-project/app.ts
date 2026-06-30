import { add, Calculator } from './math'
import './math'

function log(msg: string): void { // simple logger
  console.log(msg)
}

export function runCalculation(x: number, y: number): number {
  if (!process.env.APP_TOKEN) {
    throw new TypeError('Missing token')
  }

  const calc = new Calculator()
  const prod = calc.multiply(x, y)
  return add(prod, 10)
}

function decorator(
  _target: any,
  _key?: PropertyKey,
  descriptor?: PropertyDescriptor,
): any {
  return descriptor ?? _target
}

@decorator
export class Service {
  @decorator
  name: string = 'service'

  @decorator
  run(): void {
    log(process.env['SERVICE_KEY'] ?? '')
  }
}
