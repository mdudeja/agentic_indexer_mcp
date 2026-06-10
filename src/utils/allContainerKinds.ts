import type { SymbolKind } from 'src/database/schemas'
import { allCodebaseLanguages } from './allCodebaseLanguages'
import { AppStateManager } from 'src/state'

export async function allContainerKinds(): Promise<SymbolKind[]> {
  const languages = await allCodebaseLanguages()
  const containerKinds = Array.from(languages!).flatMap((lang) => {
    return (
      AppStateManager.getInstance().getItem('config')?.languages?.[lang]
        ?.treesitter?.lists.container_kinds ?? []
    )
  })
  return Array.from(new Set(containerKinds))
}
