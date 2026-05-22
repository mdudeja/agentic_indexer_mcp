import { join } from 'path'
import { existsSync } from 'node:fs'
import type { IndexerDB } from 'src/database/IndexerDB'
import type { IndexerConfig, IndexedSymbol } from 'src/config/types'
import { SymbolKind } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { logDebug, logInfo, logWarning } from 'src/utils/logger'
import { createProvider } from '../docstrings/providers'
import { formatComment, getCommentText } from '../docstrings/formatComment'

/** Orchestrates the generation and application of missing docstrings for code symbols by querying a database, using an AI provider, and optionally updating source files. */
export class DocstringGenerationStep {
  private config: IndexerConfig
  private cwd: string

  /** Initializes a new instance with the specified current working directory and retrieves the application configuration. */
  constructor(cwd: string) {
    this.cwd = cwd
    this.config = AppStateManager.getInstance().getItem('config')!
  }

  /** Generates and applies missing docstrings to symbols by querying the database, using a configured provider, and optionally updating source files. */
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

    logDebug(`[Indexer] Found ${symbols.length} symbols needing docstrings.`)
    symbols.forEach((s) =>
      logDebug(
        `[Indexer] Symbol needing docstring: ${s.name} (${s.kind}) in ${s.file_path}:${s.line}`,
      ),
    )

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
          const indent = (fileLines[sym.line] ?? '').match(/^(\s*)/)?.[1] ?? ''
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

  /** Removes all symbol docstrings from the database and corresponding source files. */
  async removeAllDocstrings(store: IndexerDB): Promise<void> {
    const targetKinds = this.collectTargetKinds()
    if (targetKinds.length === 0) return

    const symbols = await store.getSymbolsWithDocstrings(targetKinds)
    if (symbols.length === 0) {
      logInfo('[Indexer] No symbols have docstrings to remove.')
      return
    }

    for (const sym of symbols) {
      await store.deleteSymbolDocstring(sym.id)
    }

    logInfo(
      `[Indexer] Removed docstrings from ${symbols.length} symbols in the database.`,
    )

    const docCfg = this.config.docstring_generation
    if (!docCfg?.enabled || !docCfg.write_to_file) return

    const byFile = new Map<string, IndexedSymbol['Select'][]>()
    for (const sym of symbols) {
      const list = byFile.get(sym.file_path) ?? []
      list.push(sym)
      byFile.set(sym.file_path, list)
    }

    for (const [relPath, fileSymbols] of byFile) {
      const absPath = join(this.cwd, relPath)
      if (!existsSync(absPath)) continue

      // Process bottom-up so splice deletions don't shift unprocessed line indices
      fileSymbols.sort((a, b) => b.line - a.line)
      const fileLines = await Bun.file(absPath)
        .text()
        .then((t) => t.split('\n'))

      for (const sym of fileSymbols) {
        const startLine = sym.line
        const docstringLines = sym.docstring?.split('\n').length ?? 0
        if (docstringLines === 0) continue

        const docstringText = fileLines
          .slice(startLine - docstringLines, startLine)
          .join('\n')
          .trim()

        if (
          getCommentText(docstringText) !==
          getCommentText(formatComment(sym.docstring!, sym.language))
        ) {
          logWarning(
            `[Indexer] Docstring text in file for ${sym.name} does not match database. Skipping removal in file for safety.`,
          )
          continue
        }

        fileLines.splice(startLine - docstringLines, docstringLines)
      }

      await Bun.write(absPath, fileLines.join('\n'))
    }

    logInfo(
      `[Indexer] Removed docstrings from source files for ${symbols.length} symbols.`,
    )
  }

  /** Aggregates a unique list of symbol kinds associated with container and callable nodes across all configured languages. */
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

  /** Constructs a prompt string for generating a docstring using symbol metadata and source code. */
  private buildPrompt(
    sym: IndexedSymbol['Select'],
    sourceText: string,
  ): string {
    const parts = [
      `Generate a concise docstring for the following ${sym.kind} named "${sym.name}".`,
      `Do not format the docstring in a way. No code fences, markdown formatting, triple quotes, or language-specific comment syntax.`,
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
    parts.push(`Programming language: ${sym.language}`)
    parts.push(
      'Return only the docstring text, no code fences, no explanations.',
    )

    return parts.join('\n')
  }
}
