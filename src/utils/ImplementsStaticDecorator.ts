/** Generates a type that requires implementing static members defined in an interface T. */
export function ImplementsStatic<T>() {
  return <U extends T>(target: U) => target
}
