import { join } from 'path'
import { existsSync } from 'node:fs'
import type { IndexerDB } from 'src/database/IndexerDB'
import type { IndexerConfig, IndexedSymbol } from 'src/config/types'
import { SymbolKind } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { logInfo, logWarning } from 'src/utils/logger'
import { createProvider } from '../docstrings/providers'
import { formatComment } from '../docstrings/formatComment'

export class DocstringGenerationStep {
  private config: IndexerConfig
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    this.config = AppStateManager.getInstance().getItem('config')!
  }

  async run(store: IndexerDB): Promise<void> {
    const docCfg = this.config.docstring_generation
    if (!docCfg?.enabled) return

    logInfo('[Indexer] Running Step 3: Docstring Generation...')

    const targetKinds = this.collectTargetKinds()
    if (targetKinds.length === 0) return

    const symbols = await store.getSymbolsNeedingDocstrings(targetKinds)
    if (symbols.length === 0) {
      logInfo('[Indexer] No symbols need docstrings. Step 3 complete.')
      return
    }

    const provider = createProvider(docCfg)
    if (!provider) return

    let generated = 0

    const byFile = new Map<string, IndexedSymbol['Select'][]>()
    for (const sym of symbols) {
      const list = byFile.get(sym.file_path) ?? []
      list.push(sym)
      byFile.set(sym.file_path, list)
    }

    for (const [relPath, fileSymbols] of byFile) {
      const absPath = join(this.cwd, relPath)
      if (!existsSync(absPath)) continue

      const sourceText = await Bun.file(absPath).text()
      const fileLines = sourceText.split('\n')

      // Process bottom-up so splice inserts don't shift unprocessed line indices
      fileSymbols.sort((a, b) => b.line - a.line)

      for (const sym of fileSymbols) {
        // tree-sitter lines are 0-indexed
        const endLine = sym.end_line ?? sym.line
        const symText = fileLines.slice(sym.line, endLine + 1).join('\n')

        const prompt = this.buildPrompt(sym, symText)
        const docstring = await provider.generate(prompt)
        if (!docstring) {
          logWarning(
            `[Indexer] Failed to generate docstring for ${sym.name} in ${relPath}`,
          )
          continue
        }

        await store.updateSymbolDocstring(sym.id, docstring)
        generated++

        if (docCfg.write_to_file) {
          const indent = ' '.repeat(sym.column)
          const comment = formatComment(docstring, sym.language)
          const indentedComment = comment
            .split('\n')
            .map((l) => `${indent}${l}`)
            .join('\n')
          fileLines.splice(sym.line, 0, indentedComment)
        }
      }

      if (docCfg.write_to_file) {
        await Bun.write(absPath, fileLines.join('\n'))
      }
    }

    logInfo(`[Indexer] Step 3 complete. Generated ${generated} docstrings.`)
  }

  private collectTargetKinds(): SymbolKind[] {
    const kinds = new Set<SymbolKind>()
    for (const langCfg of Object.values(this.config.languages)) {
      const { nodes_info, lists } = langCfg.treesitter
      for (const nodeType of [
        ...lists.container_nodes,
        ...lists.callable_nodes,
      ]) {
        const info = nodes_info[nodeType]
        if (info?.kind) kinds.add(info.kind)
      }
    }
    return [...kinds]
  }

  private buildPrompt(
    sym: IndexedSymbol['Select'],
    sourceText: string,
  ): string {
    const parts = [
      `Generate a concise docstring for the following ${sym.kind} named "${sym.name}".`,
      `Do not format the docstring in a way that is specific to any particular programming language. Just return the plain text of the docstring without any code fences, markdown formatting, or language-specific comment syntax.`,
      `Language: ${sym.language}`,
    ]

    if (sym.signature) parts.push(`Signature: ${sym.signature}`)

    if (sym.parameters_json) {
      try {
        const params = JSON.parse(sym.parameters_json) as Array<{
          name: string
          type: string
        }>
        if (params.length > 0) {
          parts.push(
            `Parameters: ${params.map((p) => `${p.name}: ${p.type}`).join(', ')}`,
          )
        }
      } catch {
        // malformed JSON — skip parameters
      }
    }

    if (sym.return_type) parts.push(`Return type: ${sym.return_type}`)

    parts.push(`Source:\n${sourceText}`)
    parts.push(
      'Return only the docstring text, no code fences, no explanations.',
    )

    return parts.join('\n')
  }
}
