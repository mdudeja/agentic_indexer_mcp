import { SymbolKind } from 'src/database/schemas'

/** Returns all callable kinds configured for the codebase. */
export async function allCallableKinds(): Promise<SymbolKind[]> {
  return [
    SymbolKind.function,
    SymbolKind.method,
    SymbolKind.arrowFunction,
  ]
}
