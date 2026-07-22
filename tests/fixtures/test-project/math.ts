import * as fs from 'node:fs'
import {} from 'node:path'

export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

function internalHelper(): string {
  return fs.existsSync('/') ? 'ok' : 'no'
}

export { internalHelper }

export class Calculator {
  label: string = 'calc'

  multiply(a: number, b: number): number {
    const result = a * b
    return result
  }
}

export interface Shape {
  area(): number
}

export type Vector = { x: number; y: number }

export enum Direction {
  Up = 'UP',
  Down = 'DOWN',
}

export namespace MathUtils {
  export function clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi)
  }
}

// Trailing inline docstring
export const PI = 3.14159 // ratio of circumference to diameter
export let counter = 0
export var legacyFlag = false

export const double = (x: number): number => x * 2

export class Point {
  constructor(
    public readonly x: number,
    private _y: number,
  ) {}

  distanceTo(other: Point): number {
    const dx = this.x - other.x
    const dy = this._y - other._y
    return Math.sqrt(dx * dx + dy * dy)
  }
}

export function wrapValue(v: number) {
  return { double: () => v * 2 }
}

// Exercises callee_base default-value (`??`) stripping in TypescriptCallSiteResolver.
export function useFallback(a?: number): number {
  return wrapValue(a ?? 5).double()
}

// Exercises callee_base type-cast-prefix stripping and parenthesis unwrapping.
export function castThenCall(value: unknown): number {
  return (value as Point).distanceTo(new Point(0, 0))
}

// Exercises optional-chaining member calls.
export function optionalChainCall(p?: Point): number | undefined {
  return p?.distanceTo?.(new Point(0, 0))
}
