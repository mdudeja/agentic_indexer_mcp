import { join } from 'path'
import { existsSync } from 'node:fs'
import type { IndexerDB } from 'src/database/IndexerDB'
import type { IndexerConfig, IndexedSymbol } from 'src/config/types'
import { SymbolKind } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { logDebug, logInfo, logWarning } from 'src/utils/logger'
import { createProvider } from '../docstrings/providers'
import { formatComment, getCommentText } from '../docstrings/formatComment'
import type { DocstringProvider } from '../docstrings/providers/DocStringProvider'

/** Generates and manages docstrings for code symbols based on configured settings, including generation of new docstrings and removal of existing ones. */
export class DocstringGenerationStep {
  private config: IndexerConfig
  private cwd: string

  /** Initializes an instance by setting the current working directory and fetching configuration data. */
  constructor(cwd: string) {
    this.cwd = cwd
    this.config = AppStateManager.getInstance().getItem('config')!
  }

  /** Generate docstrings for symbols in source files based on configured settings. */
  async run(store: IndexerDB): Promise<void> {
    const docCfg = this.config.docstring_generation
    if (!docCfg?.enabled) return

    logInfo('[Indexer] Running Step 3: Docstring Generation...')

    const targetKinds = await this.collectTargetKinds()
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
      const generatedForFile = await this.generateForFile(
        store,
        provider,
        docCfg,
        relPath,
        fileSymbols,
      )
      generated += generatedForFile
      logInfo(
        `[Indexer] Generated ${generatedForFile} / ${fileSymbols.length} docstrings for ${relPath}...`,
      )
    }

    logInfo(`[Indexer] Step 3 complete. Generated ${generated} docstrings.`)
  }

  /** Generate a docstring for a single file, used when processing an individual file change. */
  async runOnOneFile(relativePath: string, store: IndexerDB): Promise<void> {
    const docCfg = this.config.docstring_generation
    if (!docCfg?.enabled) return

    const targetKinds = await this.collectTargetKinds()
    if (targetKinds.length === 0) return

    const fileSymbols = await store.getSymbolsNeedingDocstringsForFile(
      relativePath,
      targetKinds,
    )
    if (fileSymbols.length === 0) {
      logInfo(
        `[Indexer] No symbols needing docstrings found in ${relativePath}. Skipping docstring generation for this file.`,
      )
      return
    }

    logDebug(
      `[Indexer] Found ${fileSymbols.length} symbols needing docstrings in ${relativePath}.`,
    )

    const generatedForFile = await this.generateForFile(
      store,
      createProvider(docCfg)!,
      docCfg,
      relativePath,
      fileSymbols,
    )

    logInfo(
      `[Indexer] Docstring generation complete for ${relativePath}. Generated ${generatedForFile} docstrings.`,
    )
  }

  /** Removes all docstrings from the database and optionally from source files if configured. */
  async removeAllDocstrings(store: IndexerDB): Promise<void> {
    const targetKinds = await this.collectTargetKinds()
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

  private async collectTargetKinds(): Promise<SymbolKind[]> {
    const { allCallableKinds } = await import('../../utils/allCallableKinds')
    const { allContainerKinds } = await import('../../utils/allContainerKinds')
    const callables = await allCallableKinds()
    const containers = await allContainerKinds()
    return Array.from(new Set([...callables, ...containers]))
  }

  /** Constructs a detailed prompt for generating a concise docstring by compiling relevant information about a symbol and its context. */
  private buildPrompt(
    sym: IndexedSymbol['Select'],
    sourceText: string,
  ): string {
    const parts = [
      `Generate a concise docstring for the following ${sym.kind} named "${sym.name}".`,
      `The docstring should only describe the purpose of ${sym.name}. Do not include information about parameters, return types, or implementation details unless they are essential to understanding the purpose. Focus on the "why" and "what", not the "how".`,
      `IMPORTANT: Do not format the docstring with comment syntax; just provide the raw text. No code fences, no syntax, no triple quotes, no \`\`\` blocks, no explanations, just the docstring text.`,
      `The Signature, Parameters, Return type, Source and Programming language fields below are provided for context only, and should NOT be included in the generated docstring.`,
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

  /** Generates docstrings for all symbols in a given file, updating the database and optionally writing them back to the source file based on configuration. */
  private async generateForFile(
    store: IndexerDB,
    provider: DocstringProvider,
    docCfg: NonNullable<IndexerConfig['docstring_generation']>,
    relPath: string,
    fileSymbols: IndexedSymbol['Select'][],
  ): Promise<number> {
    let generated = 0
    const absPath = join(this.cwd, relPath)
    if (!existsSync(absPath)) return generated

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

      generated++

      // Remove anything within <think> tags if present
      const cleanedDocstring = docstring
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim()
      if (cleanedDocstring.length === 0) {
        logWarning(
          `[Indexer] Generated docstring for ${sym.name} in ${relPath} was empty after cleaning. Skipping.`,
        )
        continue
      }

      await store.updateSymbolDocstring(
        sym.id,
        getCommentText(cleanedDocstring),
      )
      logDebug(
        `[Indexer] Generated docstring for ${sym.name} in ${relPath}:${sym.line}`,
      )

      if (docCfg.write_to_file) {
        const indent = (fileLines[sym.line] ?? '').match(/^(\s*)/)?.[1] ?? ''
        const comment = formatComment(cleanedDocstring, sym.language)
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
    return generated
  }
}
