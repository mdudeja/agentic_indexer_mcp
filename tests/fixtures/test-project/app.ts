import { add, Calculator } from './math'
import './math'

function log(msg: string): void {
  // simple logger
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

function decoratorFactory() {
  return (_target: any, _key?: PropertyKey, descriptor?: PropertyDescriptor) =>
    descriptor
}

// Exercises: super(...) constructor calls, super.method() calls, and a
// decorator applied with call syntax (as opposed to the bare `@decorator`
// references above).
export class ServiceWithArgs extends Service {
  constructor() {
    super()
  }

  @decoratorFactory()
  override run(): void {
    super.run()
  }
}

const actions: Record<string, () => void> = {
  run: () => log('dynamic run'),
}

// Exercises a dynamic bracket call with a literal string key.
export function invokeDynamicAction(): void {
  actions['run']?.()
}
