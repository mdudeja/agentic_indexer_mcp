import { AppStateManager } from 'src/state'
import { allCodebaseLanguages } from './allCodebaseLanguages'
import type { SymbolKind } from 'src/database/schemas'

/** Returns all callable kinds from the configured languages in the codebase. */
export async function allCallableKinds(): Promise<SymbolKind[]> {
  const languages = await allCodebaseLanguages()
  const callableKinds = Array.from(languages!).flatMap((lang) => {
    return (
      AppStateManager.getInstance().getItem('config')?.languages?.[lang]
        ?.treesitter?.lists.callable_kinds ?? []
    )
  })
  return Array.from(new Set(callableKinds))
}
