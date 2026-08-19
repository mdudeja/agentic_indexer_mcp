import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { AppStateManager } from 'src/state'
import { resolveWorkspacePath } from 'src/utils/paths'
import { updateUsage } from 'src/utils/updateUsage'
import { resolveSymbol, resolveFile } from './helpers/symbolLookup'
import { formatParameters, formatInheritence } from './helpers/format'

enum READ_MODE {
  definition = 'definition',
  snippet = 'snippet',
  summary = 'summary',
}

/** Registers the read_code tool: read symbol definitions, arbitrary file snippets, or a file summary. */
export function registerReadCodeTool(server: McpServer) {
  server.registerTool(
    'read_code',
    {
      title: 'Read Code',
      description:
        'Read source code efficiently without loading whole files. ' +
        '\n\n' +
        'THREE MODES: ' +
        '`definition` — fetch the full source of a symbol (by symbol_id, or name + file_path_or_name). ' +
        '`snippet` — read an arbitrary 1-based line range from a file (configs, imports, boilerplate not bound to a symbol). ' +
        '`summary` — overview of a file: its symbols grouped by kind, its imports, and which files import it. ' +
        '\n\n' +
        'WHEN TO USE: After locating a symbol via `search_codebase`, call `read_code` (mode=definition) to read the actual implementation before reasoning about or modifying it. ' +
        'Use mode=snippet to view raw source segments. Use mode=summary to get a quick file-level overview including its dependencies and dependents. ' +
        '\n\n' +
        'OUTPUT FORMAT: definition and snippet return a fenced code block with the language tag. ' +
        'summary returns a structured text report with symbols, imports, and importers sections.',
      inputSchema: z.object({
        mode: z
          .enum(READ_MODE)
          .default(READ_MODE.definition)
          .describe(
            'What to read: definition, snippet, or summary (default: definition)',
          ),
        symbol_id: z
          .string()
          .optional()
          .describe(
            'The unique ID of the symbol (preferred for definition mode)',
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Symbol name (used with file_path_or_name for definition mode)',
          ),
        file_path_or_name: z
          .string()
          .optional()
          .describe(
            'File name or path relative to workspace root. Supports partial matches. Required for snippet/summary modes, and for definition when using name.',
          ),
        start_line: z
          .number()
          .optional()
          .describe('1-based start line (inclusive) for snippet mode'),
        end_line: z
          .number()
          .optional()
          .describe('1-based end line (inclusive) for snippet mode'),
      }),
    },
    async ({
      mode,
      symbol_id,
      name,
      file_path_or_name,
      start_line,
      end_line,
    }) => {
      const store = IndexerDB.getInstance()
      const m = mode ?? READ_MODE.definition

      switch (m) {
        case READ_MODE.definition:
          return readDefinition(store, symbol_id, name, file_path_or_name)
        case READ_MODE.snippet:
          if (!file_path_or_name || start_line == null || end_line == null) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'snippet mode requires file_path_or_name, start_line, and end_line.',
                },
              ],
              isError: true,
            }
          }
          return readSnippet(store, file_path_or_name, start_line, end_line)
        case READ_MODE.summary:
          if (!file_path_or_name) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'summary mode requires file_path_or_name.',
                },
              ],
              isError: true,
            }
          }
          return readSummary(store, file_path_or_name)
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${m}` }],
            isError: true,
          }
      }
    },
  )
}

/** Reads the full source of a symbol from disk. */
async function readDefinition(
  store: IndexerDB,
  symbol_id?: string,
  name?: string,
  file_path_or_name?: string,
): Promise<ToolResult> {
  try {
    const resolved = await resolveSymbol(store, {
      symbol_id,
      name,
      file_path_or_name,
    })
    if (!resolved.ok) {
      return { content: [{ type: 'text', text: resolved.error }] }
    }
    const symbol = resolved.symbol

    const absPath = resolveWorkspacePath(
      join(
        AppStateManager.getInstance().getItem('root') ?? '',
        symbol.file_path,
      ),
    )
    const fileContent = readFileSync(absPath, 'utf-8')
    const lines = fileContent.split('\n')

    let defText = ''
    if (symbol.end_line != null) {
      defText = lines.slice(symbol.line, symbol.end_line + 1).join('\n')
    } else {
      defText =
        lines.slice(symbol.line, symbol.line + 10).join('\n') +
        '\n// ... (truncated)'
    }

    const output = `Definition of ${symbol.name} in ${symbol.file_path}:\n\n\`\`\`${symbol.language}\n${defText}\n\`\`\``

    await updateUsage('read_code', [symbol.file_path], output.length)

    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting definition: ${err}` }],
      isError: true,
    }
  }
}

/** Reads an arbitrary line range from a file. */
async function readSnippet(
  store: IndexerDB,
  file_path_or_name: string,
  start_line: number,
  end_line: number,
): Promise<ToolResult> {
  const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
  try {
    const files = await store.files.getByPartialNameOrPath(file_path_or_name)
    if (!files.length) {
      return {
        content: [
          {
            type: 'text',
            text: 'No file found with the provided path or name',
          },
        ],
      }
    }
    if (files.length > 1) {
      return {
        content: [
          {
            type: 'text',
            text: 'Multiple files found with the provided path or name. Please provide a more specific path or name',
          },
        ],
      }
    }
    const file = files[0]!
    const absPath = resolveWorkspacePath(join(cwd, file.path))
    if (!existsSync(absPath)) {
      return {
        content: [
          { type: 'text', text: `File not found: ${file_path_or_name}` },
        ],
        isError: true,
      }
    }

    const content = readFileSync(absPath, 'utf8')
    const lines = content.split('\n')

    const start = Math.max(1, start_line) - 1
    const end = Math.min(lines.length, end_line)

    if (start > end) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid line range: ${start_line} to ${end_line}. Total lines in file: ${lines.length}.`,
          },
        ],
        isError: true,
      }
    }

    const snippet = lines.slice(start, end).join('\n')
    const ext = file.path.split('.').pop() || ''
    const exntToLangMap =
      AppStateManager.getInstance().getItem('config')?.extnToLangMap ?? {}
    const output = `Lines ${start_line}-${end_line} of ${file_path_or_name}:\n\`\`\`${exntToLangMap[ext] || ext}\n${snippet}\n\`\`\``

    await updateUsage('read_code', [file_path_or_name], output.length)

    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading file snippet: ${err}` }],
      isError: true,
    }
  }
}

/** Produces a summary of a file: its symbols, imports, and importers. */
async function readSummary(
  store: IndexerDB,
  file_path_or_name: string,
): Promise<ToolResult> {
  try {
    const resolved = await resolveFile(store, file_path_or_name)
    if (!resolved.ok) {
      return { content: [{ type: 'text', text: resolved.error }] }
    }
    const file = resolved.file

    const [symbols, imports, importers] = await Promise.all([
      store.symbols.getForFile(file.path),
      store.imports.getByFilePath(file.path),
      store.imports.getImporters(file.path),
    ])

    const sections: string[] = []
    sections.push(
      `# ${file.path} [${file.language}] (indexed: ${new Date(file.indexed_at).toISOString()})`,
    )

    // Symbols grouped by kind
    const byKind = new Map<string, typeof symbols>()
    for (const sym of symbols) {
      const group = byKind.get(sym.kind) ?? []
      group.push(sym)
      byKind.set(sym.kind, group)
    }
    if (symbols.length > 0) {
      const kindSections: string[] = []
      for (const [kind, syms] of byKind) {
        const lines = syms.map((s) => {
          let line = `  - ${s.name} (line ${s.line + 1})`
          if (s.exported) line += ' [exported]'
          if (s.signature) line += `\n    Signature: ${s.signature}`
          if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
          const params = formatParameters(s)
          if (params !== '(none)') line += `\n    Parameters: ${params}`
          if (s.return_type) line += `\n    Returns: ${s.return_type}`
          line += formatInheritence(s)
          return line
        })
        kindSections.push(`## ${kind.toUpperCase()}\n${lines.join('\n')}`)
      }
      sections.push(
        `Total symbols: ${symbols.length}, Exported: ${symbols.filter((s) => s.exported).length}\n\n${kindSections.join('\n\n')}`,
      )
    } else {
      sections.push('Total symbols: 0')
    }

    // Imports
    if (imports.length > 0) {
      const importLines = imports.map(
        (i) =>
          `  - ${i.importedNames?.join(', ') || '*'} from '${i.sourceModule}'`,
      )
      sections.push(`## Imports (${imports.length})\n${importLines.join('\n')}`)
    } else {
      sections.push('## Imports (none)')
    }

    // Importers (files that import this file)
    const importerFiles = [...new Set(importers.map((i) => i.file_path))]
    if (importerFiles.length > 0) {
      sections.push(
        `## Imported by (${importerFiles.length})\n${importerFiles.map((p) => `  - ${p}`).join('\n')}`,
      )
    } else {
      sections.push('## Imported by (none)')
    }

    const output = sections.join('\n\n')
    await updateUsage('read_code', [file.path], output.length)

    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error reading file summary: ${err}` }],
      isError: true,
    }
  }
}
