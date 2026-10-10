import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { join } from 'path'
import { readFileSync } from 'fs'
import { simpleGit } from 'simple-git'
import { AppStateManager } from 'src/state'
import { resolveWorkspacePath } from 'src/utils/paths'
import { updateUsage } from 'src/utils/updateUsage'
import { resolveSymbol } from './helpers/symbolLookup'
import { noResults } from './helpers/noResults'
import { like, or } from 'drizzle-orm'
import * as schema from 'src/database/schemas'
import { SymbolKind } from 'src/database/schemas'
import { doesPathMatch, getTestFileGlobs } from 'src/utils/pathGlobs'

const ALL_KINDS = Object.keys(SymbolKind) as (keyof typeof SymbolKind)[]

enum INSPECT_MODE {
  definition = 'definition',
  type_at_location = 'type_at_location',
  references = 'references',
  importance = 'importance',
  history = 'history',
  resolve_type = 'resolve_type',
  class_hierarchy = 'class_hierarchy',
}

const DAMPING = 0.85
const ITERATIONS = 30

/** Registers the inspect_symbol tool: deep-dive on a single symbol. */
export function registerInspectSymbolTool(server: McpServer) {
  server.registerTool(
    'inspect_symbol',
    {
      title: 'Inspect Symbol',
      description:
        'Deep-dive on a single symbol. Use after `search_codebase` to understand a symbol before modifying it. ' +
        '\n\n' +
        'SEVEN MODES: ' +
        '`definition` — full source of the symbol. ' +
        '`type_at_location` — LSP-resolved type of an identifier at a line:column. ' +
        '`references` — call sites, named imports, module importers, and inheritors. ' +
        '`importance` — PageRank centrality ranking across the call graph. ' +
        '`history` — git commit history for the symbol line range. ' +
        '`resolve_type` — type definition plus producers, consumers, and inheritors. ' +
        '`class_hierarchy` — ancestor and descendant class tree. ' +
        '\n\n' +
        'WHEN TO USE: To understand a symbol deeply — its implementation, type, references, importance, history, and class relationships. ' +
        'For a quick read of just the implementation, prefer `read_code` (mode=definition).',
      inputSchema: z.object({
        mode: z
          .enum(INSPECT_MODE)
          .default(INSPECT_MODE.definition)
          .describe('What to inspect (default: definition)'),
        symbol_id: z
          .string()
          .optional()
          .describe('The unique ID of the symbol (preferred)'),
        name: z
          .string()
          .optional()
          .describe('Symbol name (used with file_path_or_name)'),
        file_path_or_name: z
          .string()
          .optional()
          .describe(
            'File name or path relative to workspace root. Supports partial matches.',
          ),
        line: z
          .number()
          .optional()
          .describe('1-based line number (for type_at_location mode)'),
        column: z
          .number()
          .optional()
          .describe('1-based column number (for type_at_location mode)'),
        include_imports: z
          .boolean()
          .default(true)
          .describe('Include named imports (references mode)'),
        include_calls: z
          .boolean()
          .default(true)
          .describe('Include call sites (references mode)'),
        include_inheritors: z
          .boolean()
          .default(true)
          .describe('Include inheritors (references mode)'),
        limit: z
          .number()
          .optional()
          .describe('Max results (importance/resolve_type modes)'),
        kind: z
          .array(z.enum(ALL_KINDS))
          .optional()
          .describe('Filter by symbol kind (importance mode)'),
        exclude_tests: z
          .boolean()
          .default(true)
          .describe('Exclude test file symbols (importance mode)'),
        include_diff: z
          .boolean()
          .optional()
          .describe('Include line diff in history (history mode)'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? INSPECT_MODE.definition

      switch (mode) {
        case INSPECT_MODE.definition:
          return inspectDefinition(
            store,
            args.symbol_id,
            args.name,
            args.file_path_or_name,
          )
        case INSPECT_MODE.type_at_location:
          if (
            !args.file_path_or_name ||
            args.line == null ||
            args.column == null
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'type_at_location mode requires file_path, line, and column.',
                },
              ],
              isError: true,
            }
          }
          return inspectTypeAtLocation(
            store,
            args.file_path_or_name,
            args.line,
            args.column,
          )
        case INSPECT_MODE.references:
          if (!args.name) {
            return {
              content: [
                { type: 'text', text: 'references mode requires name.' },
              ],
              isError: true,
            }
          }
          return inspectReferences(
            store,
            args.name,
            args.file_path_or_name,
            args.include_imports,
            args.include_calls,
            args.include_inheritors,
          )
        case INSPECT_MODE.importance:
          return inspectImportance(
            store,
            args.limit,
            args.kind as (keyof typeof SymbolKind)[] | undefined,
            args.exclude_tests,
          )
        case INSPECT_MODE.history:
          return inspectHistory(
            store,
            args.symbol_id,
            args.name,
            args.file_path_or_name,
            args.include_diff,
          )
        case INSPECT_MODE.resolve_type:
          if (!args.name) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'resolve_type mode requires a name to be provided.',
                },
              ],
              isError: true,
            }
          }
          return inspectResolveType(store, args.name, args.limit)
        case INSPECT_MODE.class_hierarchy:
          return inspectClassHierarchy(
            store,
            args.symbol_id,
            args.name,
            args.file_path_or_name,
          )
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Reads the full source of a symbol from disk. */
async function inspectDefinition(
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
    await updateUsage('inspect_symbol', [symbol.file_path], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting definition: ${err}` }],
      isError: true,
    }
  }
}

/** Resolves the type of an identifier at a specific line/column via the LSP enhancer. */
async function inspectTypeAtLocation(
  store: IndexerDB,
  file_path_or_name: string,
  line: number,
  column: number,
): Promise<ToolResult> {
  const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
  const exntToLangMap =
    AppStateManager.getInstance().getItem('config')?.extnToLangMap ?? {}
  try {
    const files = await store.files.getByPartialNameOrPath(file_path_or_name)
    if (!files.length) {
      return noResults('No file found with the provided path or name')
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
    const ext = file.path.split('.').pop() || ''
    const enhancerMap = AppStateManager.getInstance().getItem('lspEnhancers')
    if (!enhancerMap) {
      return {
        content: [
          {
            type: 'text',
            text: 'LSP enhancers are not initialized. Please ensure the server is properly configured.',
          },
        ],
      }
    }

    const enhancer = enhancerMap.get(ext)
    if (!enhancer) {
      return {
        content: [
          {
            type: 'text',
            text: `Type hover is not supported or not initialized for .${ext} files.`,
          },
        ],
      }
    }

    const typeStr = await enhancer.getTypeAtLocation(
      absPath,
      line - 1,
      column - 1,
    )
    if (!typeStr) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not resolve type at ${file_path_or_name}:${line}:${column}. Make sure you are pointing to a valid identifier.`,
          },
        ],
      }
    }

    const output = `Type at ${file_path_or_name}:${line}:${column}:\n\`\`\`${exntToLangMap[ext] || ext}\n${typeStr}\n\`\`\``
    await updateUsage('inspect_symbol', [file.path], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error getting type at location: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Finds all references to a symbol: call sites, named imports, module importers, and inheritors. */
async function inspectReferences(
  store: IndexerDB,
  symbol_name: string,
  file_pattern?: string,
  include_imports = true,
  include_calls = true,
  include_inheritors = true,
): Promise<ToolResult> {
  try {
    const name = symbol_name
    const sections: string[] = []

    const symbols = await store.symbols.search(
      name,
      'all',
      file_pattern as string | undefined,
    )
    if (symbols.length === 0) {
      return noResults(`Symbol '${name}' not found in codebase.`)
    }
    if (symbols.length > 1 && !file_pattern) {
      return {
        content: [
          {
            type: 'text',
            text: `Multiple symbols found with name '${name}'. Please provide file_path_or_name to disambiguate.`,
          },
        ],
      }
    }
    const symbol = symbols[0]!

    const filePaths = new Set<string>()

    if (include_calls) {
      const allCallers = await store.callEdges.getCallersNested(symbol.name)
      if (allCallers.length > 0) {
        const callLines = allCallers.map(
          (c) =>
            `  - ${c.callerName}${c.childName ? ` (${symbol.name}.${c.childName})` : ''} in ${c.callerFile}:${c.line + 1}`,
        )
        sections.push(
          `Called at (${allCallers.length} location${allCallers.length !== 1 ? 's' : ''}):\n${callLines.join('\n')}`,
        )
        allCallers.forEach((c) => {
          filePaths.add(c.callerFile)
          if (c.childFilePath) filePaths.add(c.childFilePath)
        })
      } else {
        sections.push(`Called at: (none found)`)
      }
    }

    if (include_imports) {
      const importRefs = await store.imports.getByName(symbol.name)
      if (importRefs.length > 0) {
        const importLines = importRefs.map(
          (i) => `  - ${i.file_path} (from '${i.sourceModule}')`,
        )
        sections.push(
          `Imported by name in (${importRefs.length} file${importRefs.length !== 1 ? 's' : ''}):\n${importLines.join('\n')}`,
        )
        importRefs.forEach((i) => filePaths.add(i.file_path))
      } else {
        sections.push(`Imported by name: (none found)`)
      }
    }

    if (include_inheritors) {
      const inheritors = await store.symbols.getSymbolsInheritingFrom(
        symbol.name,
        symbol.id,
      )
      if (inheritors.length > 0) {
        const inheritorLines = inheritors.map(
          (i) => `  - ${i.name} in ${i.file_path}:${i.line + 1}`,
        )
        sections.push(
          `Inherited by (${inheritors.length} symbol${inheritors.length !== 1 ? 's' : ''}):\n${inheritorLines.join('\n')}`,
        )
        inheritors.forEach((i) => filePaths.add(i.file_path))
      } else {
        sections.push(`Inherited by: (none found)`)
      }
    }

    // Module-level importers when name looks like a path
    if (name.includes('/') || name.includes('.')) {
      const cleanedName = name.replace(/\//g, '').replace(/\.[\w]+$/g, '')
      const moduleImporters = await store.imports.getImporters(cleanedName)
      if (moduleImporters.length > 0) {
        const modLines = [
          ...new Set(moduleImporters.map((i) => i.file_path)),
        ].map((p) => `  - ${p}`)
        sections.push(
          `Module imported by (${modLines.length} file${modLines.length !== 1 ? 's' : ''}):\n${modLines.join('\n')}`,
        )
        moduleImporters.forEach((i) => filePaths.add(i.file_path))
      } else {
        sections.push(`Module imported by: (none found)`)
      }
    }

    if (sections.length === 0) {
      return {
        content: [{ type: 'text', text: `No references found for: ${name}` }],
      }
    }

    const output = `References to: ${symbol.name}\n\n${sections.join('\n\n')}`
    await updateUsage('inspect_symbol', Array.from(filePaths), output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error finding references: ${err}` }],
      isError: true,
    }
  }
}

/** Ranks symbols by structural importance using PageRank on the call graph. */
async function inspectImportance(
  store: IndexerDB,
  limit?: number,
  kind?: (keyof typeof SymbolKind)[],
  exclude_tests = true,
): Promise<ToolResult> {
  try {
    const maxLimit = limit ?? 20

    // Load all resolved call edges from the new call_edges table
    const edges = await store.callEdges.getAllWithCalleeIds()

    if (edges.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No resolved call edges found. Re-index the project to populate the call graph.',
          },
        ],
      }
    }

    const nodeIds = new Set<string>()
    for (const e of edges) {
      nodeIds.add(e.caller)
      if (e.callee) nodeIds.add(e.callee)
    }
    const N = nodeIds.size

    const outEdges = new Map<string, string[]>()
    for (const e of edges) {
      if (!e.callee) continue
      const list = outEdges.get(e.caller) ?? []
      list.push(e.callee)
      outEdges.set(e.caller, list)
    }

    let rank = new Map<string, number>()
    for (const id of nodeIds) rank.set(id, 1 / N)

    for (let i = 0; i < ITERATIONS; i++) {
      const newRank = new Map<string, number>()
      for (const id of nodeIds) newRank.set(id, (1 - DAMPING) / N)
      for (const [caller, callees] of outEdges) {
        const contribution =
          (DAMPING * (rank.get(caller) ?? 0)) / callees.length
        for (const callee of callees) {
          newRank.set(callee, (newRank.get(callee) ?? 0) + contribution)
        }
      }
      rank = newRank
    }

    const sorted = [...rank.entries()].sort((a, b) => b[1] - a[1])
    const fetchIds = sorted.slice(0, maxLimit * 5).map(([id]) => id)
    const symbols = await store.symbols.getSymbolsByIds(fetchIds)
    const symbolMap = new Map(symbols.map((s) => [s.id, s]))

    const testFileGlobs = getTestFileGlobs()
    const results: Array<{ symbol: (typeof symbols)[0]; score: number }> = []
    for (const [id, score] of sorted) {
      if (results.length >= maxLimit) break
      const sym = symbolMap.get(id)
      if (!sym) continue
      if (exclude_tests && doesPathMatch(testFileGlobs, sym.file_path)) continue
      if (kind && kind.length > 0 && !kind.includes(sym.kind as any)) continue
      results.push({ symbol: sym, score })
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No symbols matched the filters after PageRank computation.',
          },
        ],
      }
    }

    const lines: string[] = [
      `Top ${results.length} symbols by call-graph importance (PageRank, d=${DAMPING}):\n`,
      `${'Rank'.padEnd(6)} ${'Score'.padEnd(10)} ${'Kind'.padEnd(14)} ${'Symbol'}\n${'─'.repeat(70)}`,
    ]
    results.forEach(({ symbol: s, score }, i) => {
      lines.push(
        `${String(i + 1).padEnd(6)} ${score.toFixed(6).padEnd(10)} ${s.kind.padEnd(14)} ${s.name}  ${s.file_path}:${s.line + 1}`,
      )
    })

    const output = lines.join('\n')
    await updateUsage('inspect_symbol', [], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error computing symbol importance: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Fetches git commit history for a symbol's line range. */
async function inspectHistory(
  store: IndexerDB,
  symbol_id?: string,
  name?: string,
  file_path_or_name?: string,
  include_diff = false,
): Promise<ToolResult> {
  const cwd = AppStateManager.getInstance().getItem('root') ?? process.cwd()
  try {
    const resolved = await resolveSymbol(store, {
      symbol_id,
      name,
      file_path_or_name,
    })
    if (!resolved.ok) {
      return {
        content: [{ type: 'text', text: resolved.error }],
        isError: true,
      }
    }
    const symbol = resolved.symbol

    if (symbol.end_line == null) {
      return {
        content: [
          {
            type: 'text',
            text: `Symbol ${symbol.name} does not have line bounds in the database, cannot query git history.`,
          },
        ],
        isError: true,
      }
    }

    const git = simpleGit(cwd)
    const gitArgs = [
      'log',
      '-L',
      `${symbol.line + 1},${symbol.end_line + 1}:${symbol.file_path}`,
    ]
    if (!include_diff) gitArgs.push('--no-patch')

    const rawLog = await git.raw(gitArgs)

    let output = `Git history for symbol "${symbol.name}" in ${symbol.file_path} (Lines ${symbol.line + 1}-${symbol.end_line + 1}):\n\n`
    if (!rawLog || rawLog.trim().length === 0) {
      output += 'No commit history found for these lines.'
    } else {
      output += rawLog
    }

    await updateUsage('inspect_symbol', [symbol.file_path], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error fetching symbol history: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Resolves a type/interface definition and its producers, consumers, and inheritors. */
async function inspectResolveType(
  store: IndexerDB,
  name: string,
  limit?: number,
): Promise<ToolResult> {
  try {
    const db = store.getDb()
    const resultLimit = limit ?? 20

    const [typeMatches, ifaceMatches, classMatches] = await Promise.all([
      store.symbols.search(name, [SymbolKind.type], undefined, undefined, 10),
      store.symbols.search(
        name,
        [SymbolKind.interface],
        undefined,
        undefined,
        10,
      ),
      store.symbols.search(name, [SymbolKind.class], undefined, undefined, 10),
    ])
    const definitions = [...typeMatches, ...ifaceMatches, ...classMatches]

    const producers = await db
      .select({
        name: schema.symbols.name,
        kind: schema.symbols.kind,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        signature: schema.symbols.signature,
        return_type: schema.symbols.return_type,
      })
      .from(schema.symbols)
      .where(
        or(
          like(schema.symbols.return_type, `%${name}%`),
          like(schema.symbols.signature, `%${name}%`),
        ),
      )
      .limit(resultLimit)

    const consumers = await db
      .select({
        name: schema.symbols.name,
        kind: schema.symbols.kind,
        file_path: schema.symbols.file_path,
        line: schema.symbols.line,
        signature: schema.symbols.signature,
        parameters_json: schema.symbols.parameters_json,
      })
      .from(schema.symbols)
      .where(
        or(
          like(schema.symbols.parameters_json, `%${name}%`),
          like(schema.symbols.signature, `%${name}%`),
        ),
      )
      .limit(resultLimit)

    const inheritors = await store.symbols.getSymbolsInheritingFrom(name)

    const sections: string[] = []

    if (definitions.length > 0) {
      const defLines = definitions.map((d) => {
        let line = `  [${d.kind.toUpperCase()}] ${d.name} in ${d.file_path}:${d.line + 1}`
        if (d.exported) line += ' [exported]'
        if (d.signature) line += `\n  Signature: ${d.signature}`
        return line
      })
      sections.push(
        `Definition (${definitions.length} found):\n${defLines.join('\n')}`,
      )
    } else {
      sections.push(
        `Definition: not found in index (may be from an external library)`,
      )
    }

    if (producers.length > 0) {
      const prodLines = producers.map(
        (p) =>
          `  - ${p.name} (${p.file_path}:${p.line + 1})${p.signature ? `: ${p.signature}` : ''}`,
      )
      sections.push(
        `Produced by — functions returning ${name} (approximate match, ${producers.length}):\n${prodLines.join('\n')}`,
      )
    } else {
      sections.push(`Produced by: (none found)`)
    }

    if (consumers.length > 0) {
      const conLines = consumers.map((c) => {
        let paramSummary = ''
        if (c.parameters_json) {
          try {
            const params = JSON.parse(c.parameters_json) as Array<{
              name: string
              type?: string
            }>
            const matching = params.filter((p) => p.type?.includes(name))
            if (matching.length > 0) {
              paramSummary = ` [param: ${matching.map((p) => `${p.name}: ${p.type}`).join(', ')}]`
            }
          } catch {
            // ignore malformed JSON
          }
        }
        return `  - ${c.name} (${c.file_path}:${c.line + 1})${paramSummary}`
      })
      sections.push(
        `Consumed by — functions accepting ${name} as parameter (approximate match, ${consumers.length}):\n${conLines.join('\n')}`,
      )
    } else {
      sections.push(`Consumed by: (none found)`)
    }

    if (inheritors.length > 0) {
      const inheritLines = inheritors.map((i) => {
        const rel = i.inheritence!.find(
          (inh) => inh.inherits_from_name === name,
        )
        return `  [${rel?.inheritence_type?.toUpperCase() ?? 'EXTENDS'}] ${i.name} (${i.kind}) in ${i.file_path}:${i.line + 1}`
      })
      sections.push(
        `Inheritors — types/interfaces/classes extending or composing ${name} (${inheritors.length}):\n${inheritLines.join('\n')}`,
      )
    } else {
      sections.push(`Inheritors: (none found)`)
    }

    const output = `Type: ${name}\n\n${sections.join('\n\n')}`
    const filePaths = new Set([
      ...producers.map((p) => p.file_path),
      ...consumers.map((c) => c.file_path),
      ...inheritors.map((i) => i.file_path),
    ])
    await updateUsage('inspect_symbol', Array.from(filePaths), output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error resolving type: ${err}` }],
      isError: true,
    }
  }
}

/** Builds a class hierarchy tree for a symbol (parents and descendants via parent_id + inheritence). */
async function inspectClassHierarchy(
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

    const lines: string[] = []
    lines.push(
      `Class hierarchy for: ${symbol.name} [${symbol.kind}] (${symbol.file_path}:${symbol.line + 1})`,
    )

    // Ancestors (walk parent_id up to a class, plus inheritence entries)
    const ancestors: string[] = []
    let current: typeof symbol | null = symbol
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      if (current.inheritence && current.inheritence.length > 0) {
        for (const inh of current.inheritence) {
          ancestors.push(
            `  ${inh.inheritence_type} ${inh.inherits_from_name}${inh.inherits_from_id ? ` (id=${inh.inherits_from_id})` : ''}`,
          )
        }
      }
      if (current.parent_id) {
        const parent = await store.symbols.getDefinition(current.parent_id)
        if (parent) {
          ancestors.push(
            `  parent ${parent.name} (${parent.file_path}:${parent.line + 1})`,
          )
          current = parent
          continue
        }
      }
      break
    }
    if (ancestors.length > 0) {
      lines.push(`\nAncestors / inherited from:\n${ancestors.join('\n')}`)
    } else {
      lines.push(`\nAncestors / inherited from: (none)`)
    }

    // Descendants (children via parent_id, and symbols inheriting from this)
    const descendants: string[] = []
    const children = await store.symbols.getChildSymbols(symbol.id)
    for (const child of children) {
      descendants.push(
        `  - ${child.name} [${child.kind}] (${child.file_path}:${child.line + 1})`,
      )
    }
    const inheritors = await store.symbols.getSymbolsInheritingFrom(
      symbol.name,
      symbol.id,
    )
    for (const inh of inheritors) {
      if (inh.id !== symbol.id) {
        descendants.push(
          `  - ${inh.name} [${inh.kind}] (${inh.file_path}:${inh.line + 1})`,
        )
      }
    }
    if (descendants.length > 0) {
      lines.push(`\nDescendants / inheritors:\n${descendants.join('\n')}`)
    } else {
      lines.push(`\nDescendants / inheritors: (none)`)
    }

    const output = lines.join('\n')
    await updateUsage('inspect_symbol', [symbol.file_path], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error building class hierarchy: ${err}` },
      ],
      isError: true,
    }
  }
}
