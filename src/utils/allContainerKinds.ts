import { SymbolKind } from 'src/database/schemas'

/** Returns all container kinds configured for the codebase. */
export async function allContainerKinds(): Promise<SymbolKind[]> {
  return [
    SymbolKind.class,
    SymbolKind.module,
    SymbolKind.namespace,
  ]
}
