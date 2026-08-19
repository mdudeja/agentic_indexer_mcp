import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { updateUsage } from 'src/utils/updateUsage'
import { doesPathMatch, getTestFileGlobs } from 'src/utils/pathGlobs'
import * as schema from 'src/database/schemas'
import { formatParameters } from './helpers'

enum IMPACT_MODE {
  blast_radius = 'blast_radius',
  related_tests = 'related_tests',
  required_env_vars = 'required_env_vars',
  error_flow = 'error_flow',
  data_flow = 'data_flow',
}

/** Registers the analyze_change_impact tool: risk assessment before a change. */
export function registerAnalyzeChangeImpactTool(server: McpServer) {
  server.registerTool(
    'analyze_change_impact',
    {
      title: 'Analyze Change Impact',
      description:
        'Assess the risk and blast radius of a change before you make it. ' +
        '\n\n' +
        'FIVE MODES: ' +
        '`blast_radius` — all transitive callers that might break if you change a symbol. ' +
        '`related_tests` — test files that exercise a symbol or module. ' +
        '`required_env_vars` — env vars read downstream in the call tree. ' +
        '`error_flow` — exceptions that can bubble up from a symbol. ' +
        '`data_flow` — type-level I/O boundary (params, return, callers, callees). ' +
        '\n\n' +
        'WHEN TO USE: Before refactoring or modifying a symbol, to know what could break and what to test. ' +
        'Run `blast_radius` to see who is affected, `related_tests` to know what to run, and `required_env_vars`/`error_flow` to understand runtime requirements and failure modes.',
      inputSchema: z.object({
        mode: z
          .enum(IMPACT_MODE)
          .default(IMPACT_MODE.blast_radius)
          .describe('What to analyze (default: blast_radius)'),
        symbol_name: z
          .string()
          .optional()
          .describe('Name of the symbol to analyze'),
        file_pattern: z
          .string()
          .optional()
          .describe('Filter by file path pattern (blast_radius mode)'),
        file_path: z.string().optional().describe('File path to disambiguate'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? IMPACT_MODE.blast_radius

      switch (mode) {
        case IMPACT_MODE.blast_radius:
          if (!args.symbol_name) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'blast_radius mode requires symbol_name.',
                },
              ],
              isError: true,
            }
          }
          return blastRadius(store, args.symbol_name, args.file_pattern)
        case IMPACT_MODE.related_tests:
          return relatedTests(store, args.symbol_name ?? args.file_pattern)
        case IMPACT_MODE.required_env_vars:
          return requiredEnvVars(store, args.symbol_name)
        case IMPACT_MODE.error_flow:
          return errorFlow(store, args.symbol_name)
        case IMPACT_MODE.data_flow:
          if (!args.symbol_name) {
            return {
              content: [
                { type: 'text', text: 'data_flow mode requires symbol_name.' },
              ],
              isError: true,
            }
          }
          return dataFlow(store, args.symbol_name, args.file_path)
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Finds all transitive callers (BFS) of a symbol. */
async function blastRadius(
  store: IndexerDB,
  symbol_name: string,
  file_pattern?: string,
): Promise<ToolResult> {
  try {
    const name = symbol_name
    const startSymbols = await store.symbols.search(
      name,
      'all',
      file_pattern as string | undefined,
    )
    if (startSymbols.length === 0) {
      return {
        content: [
          { type: 'text', text: `Symbol '${name}' not found in codebase.` },
        ],
      }
    }
    if (startSymbols.length > 1 && !file_pattern) {
      return {
        content: [
          {
            type: 'text',
            text: `Multiple symbols found with name '${name}'. Please provide a file_pattern to disambiguate.`,
          },
        ],
      }
    }
    const startSymbol = startSymbols[0]!

    const visited = new Set<string>()
    const allCallers: Array<{
      callerFile: string
      callerName: string
      line: number
    }> = []
    const queue = new Set<string>([startSymbol.name])

    while (queue.size > 0) {
      const current = queue.values().next().value
      if (!current) break
      queue.delete(current)
      if (visited.has(current)) continue
      visited.add(current)

      const callers = await store.callEdges.getCallersNested(current)
      for (const c of callers) {
        allCallers.push(c)
        queue.add(c.callerName)
      }
    }

    if (allCallers.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No callers found for '${name}'. Safe to change or may be an entry point.`,
          },
        ],
      }
    }

    const lines = allCallers.map(
      (c) => `  - ${c.callerName} (${c.callerFile}:${c.line + 1})`,
    )
    const dedupedLines = Array.from(new Set(lines)).sort()

    const output = `Blast radius for '${name}' (${dedupedLines.length} caller${dedupedLines.length !== 1 ? 's' : ''})\n${dedupedLines.join('\n')}\n\nEnsure testing covers these paths. Use trace_code_graph (mode=call_graph, direction=inbound) for a full traversal tree.`

    const filePaths = (
      await store.symbols.getSymbolsByNames(Array.from(visited))
    ).map((s) => s.file_path)
    const uniqueFilePaths = Array.from(new Set(filePaths))
    await updateUsage('analyze_change_impact', uniqueFilePaths, output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error finding blast radius: ${err}` }],
      isError: true,
    }
  }
}

/** Finds test files that exercise a symbol or module. */
async function relatedTests(
  store: IndexerDB,
  target?: string,
): Promise<ToolResult> {
  if (!target) {
    return {
      content: [
        {
          type: 'text',
          text: 'Need either the symbol name of file_pattern to find tests for',
        },
      ],
    }
  }
  const testFileGlobs = getTestFileGlobs()
  try {
    const name = target
    const allFiles = await store.files.getAll()
    const testFilePaths = new Set(
      allFiles
        .filter((f) => doesPathMatch(testFileGlobs, f.path))
        .map((f) => f.path),
    )

    if (testFilePaths.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No test files found in the indexed workspace.',
          },
        ],
      }
    }

    const found = new Map<string, string[]>()

    if (name.includes('/')) {
      const importers = await store.imports.getImporters(name)
      const testFileImporters = importers.filter((imp) =>
        testFilePaths.has(imp.file_path),
      )
      for (const imp of testFileImporters) {
        const reasons = found.get(imp.file_path) ?? []
        reasons.push(`imports module '${(imp.importedNames ?? []).join(', ')}'`)
        found.set(imp.file_path, reasons)
      }
    }

    if (!name.includes('/')) {
      const callers = await store.callEdges.getCallers(name)
      for (const c of callers) {
        if (testFilePaths.has(c.callerFile)) {
          const reasons = found.get(c.callerFile) ?? []
          reasons.push(`calls ${name} via ${c.callerName} (line ${c.line + 1})`)
          found.set(c.callerFile, reasons)
        }
      }
      const importRefs = await store.imports.getByName(name)
      for (const imp of importRefs) {
        if (testFilePaths.has(imp.file_path)) {
          const reasons = found.get(imp.file_path) ?? []
          reasons.push(`imports '${name}' by name`)
          found.set(imp.file_path, reasons)
        }
      }
    }

    if (found.size === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No test files found referencing '${name}'.\n(${testFilePaths.size} test files exist in the index — target may not be directly exercised by tests.)`,
          },
        ],
      }
    }

    const lines = [...found.entries()].map(([file, reasons]) => {
      return `  - ${file}\n${reasons.map((r) => `      • ${r}`).join('\n')}`
    })

    const output = `Related tests for: ${name}\n\nFound ${found.size} test file${found.size !== 1 ? 's' : ''}:\n${lines.join('\n')}`
    await updateUsage(
      'analyze_change_impact',
      Array.from(testFilePaths),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error finding related tests: ${err}` }],
      isError: true,
    }
  }
}

/** Traces env vars accessed downstream of a symbol. */
async function requiredEnvVars(
  store: IndexerDB,
  symbol_name?: string,
): Promise<ToolResult> {
  try {
    const results = symbol_name
      ? await store.analysis.getEnvVarsBubbleUp(symbol_name)
      : await store.analysis.getAllEnvVars()

    if (!results || results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No environment variable reads found ${symbol_name ? `in the call tree starting from: ${symbol_name}` : 'in the codebase'}`,
          },
        ],
      }
    }

    const direct = results.filter(
      (r) =>
        r.symbol_name.toLowerCase() ===
        ((symbol_name ?? '') as string).toLowerCase(),
    )
    const indirect = results.filter(
      (r) =>
        r.symbol_name.toLowerCase() !==
        ((symbol_name ?? '') as string).toLowerCase(),
    )

    let output = `Environment variables accessed downstream of "${symbol_name ?? 'all symbols'}":\n\n`

    if (direct.length > 0) {
      output += `### Directly Accessed (inside "${symbol_name ?? 'all symbols'}"):\n`
      output += direct
        .map((r) => `  - \`${r.env_var_name}\` at ${r.file_path}:${r.line + 1}`)
        .join('\n')
      output += '\n\n'
    }

    if (indirect.length > 0) {
      output += `### Downstream Accessed (propagating from downstream sub-calls):\n`
      const groups = new Map<
        string,
        Array<{ env_var_name: string; file_path: string; line: number }>
      >()
      for (const r of indirect) {
        const list = groups.get(r.symbol_name) ?? []
        list.push(r)
        groups.set(r.symbol_name, list)
      }
      for (const [subName, envList] of groups) {
        output += `  * From calling \`${subName}\`:\n`
        output += envList
          .map(
            (r) =>
              `    - \`${r.env_var_name}\` at ${r.file_path}:${r.line + 1}`,
          )
          .join('\n')
        output += '\n'
      }
    }

    const filePaths = new Set(results.map((r) => r.file_path))
    await updateUsage(
      'analyze_change_impact',
      Array.from(filePaths),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error tracing environment variables: ${err}` },
      ],
      isError: true,
    }
  }
}

/** Traces exceptions that can bubble up from a symbol. */
async function errorFlow(
  store: IndexerDB,
  symbol_name?: string,
): Promise<ToolResult> {
  try {
    const results = symbol_name
      ? await store.analysis.getExceptionsBubbleUp(symbol_name)
      : await store.analysis.getAllExceptions()

    if (!results || results.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No exceptions found ${symbol_name ? `throwing or bubbling up from: ${symbol_name}` : 'in the codebase'}`,
          },
        ],
      }
    }

    const direct = results.filter(
      (r) =>
        r.symbol_name.toLowerCase() ===
        ((symbol_name ?? '') as string).toLowerCase(),
    )
    const indirect = results.filter(
      (r) =>
        r.symbol_name.toLowerCase() !==
        ((symbol_name ?? '') as string).toLowerCase(),
    )

    let output = `Error flow analysis for "${symbol_name ?? 'all symbols'}":\n\n`

    if (direct.length > 0) {
      output += `### Direct Exceptions (thrown inside "${symbol_name ?? 'all symbols'}"):\n`
      output += direct
        .map(
          (r) =>
            `  - Throws \`${r.exception_type}\` at ${r.file_path}:${r.line + 1}`,
        )
        .join('\n')
      output += '\n\n'
    }

    if (indirect.length > 0) {
      output += `### Bubbled Up Exceptions (propagating from downstream sub-calls):\n`
      const groups = new Map<
        string,
        Array<{ exception_type: string; file_path: string; line: number }>
      >()
      for (const r of indirect) {
        const list = groups.get(r.symbol_name) ?? []
        list.push(r)
        groups.set(r.symbol_name, list)
      }
      for (const [subName, excList] of groups) {
        output += `  * From calling \`${subName}\`:\n`
        output += excList
          .map(
            (r) =>
              `    - Throws \`${r.exception_type}\` at ${r.file_path}:${r.line + 1}`,
          )
          .join('\n')
        output += '\n'
      }
    }

    const filePaths = new Set(results.map((r) => r.file_path))
    await updateUsage(
      'analyze_change_impact',
      Array.from(filePaths),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error tracing exception flow: ${err}` }],
      isError: true,
    }
  }
}

/** Shows the type-level data boundary of a function. */
async function dataFlow(
  store: IndexerDB,
  symbol_name: string,
  file_path?: string,
): Promise<ToolResult> {
  try {
    const name = symbol_name

    const candidates = await store.symbols.search(
      name,
      undefined,
      file_path as string | undefined,
      undefined,
      5,
    )
    if (candidates.length === 0) {
      return {
        content: [
          { type: 'text', text: `Symbol '${name}' not found in index.` },
        ],
      }
    }
    if (candidates.length > 1 && !file_path) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Multiple symbols named '${name}' found. Please provide a file path to disambiguate:\n` +
              candidates
                .map(
                  (c) =>
                    `  - ${c.name} [${c.kind}] (${c.file_path}:${c.line + 1})`,
                )
                .join('\n'),
          },
        ],
      }
    }

    const target = candidates[0]!

    const paramSummary = formatParameters(target)
    const returnSummary = target.return_type ?? 'unknown'

    const callers = await store.callEdges.getCallers(name)
    let callerSymbols: Array<schema.IndexedSymbol['Select']> = []
    if (callers.length > 0) {
      const callerNames = [...new Set(callers.map((c) => c.callerName))]
      callerSymbols = await store.symbols.getSymbolsByNames(callerNames)
    }
    const callerMap = new Map(callerSymbols.map((s) => [s.name, s]))

    const outboundCalls = await store.callEdges.getOutboundForSymbols([
      target.id,
    ])
    const calleeOrImportIds = outboundCalls
      .filter((c) => c.callee_id != null || c.imports_id != null)
      .map((c) => ({
        id: c.callee_id || c.imports_id,
        type: c.callee_id ? 'callee' : 'import',
      }))
    const calleeOrImportSymbols = calleeOrImportIds.map(async (entry) => {
      if (entry.type === 'callee') {
        return await store.symbols.getSymbolsByIds([entry.id!])
      } else {
        const importRecord = await store.imports.getById(entry.id!)
        if (importRecord) {
          return [
            {
              id: entry.id,
              callee_name: importRecord.sourceModule,
              kind: 'import' as const,
              file_path: importRecord.resolvedPath,
              line: 0,
              parameters_json: null,
              return_type: null,
              signature: null,
            },
          ]
        }
      }
      return []
    })
    const calleeOrImportSymbolsFlattened = (
      await Promise.all(calleeOrImportSymbols)
    ).flat()
    const calleeMap = new Map(
      calleeOrImportSymbolsFlattened.map((s) => [s.id, s]),
    )

    const sections: string[] = []
    sections.push(
      `Symbol: ${target.name} [${target.kind}] (${target.file_path}:${target.line + 1})\nParameters: ${paramSummary}\nReturns:    ${returnSummary}`,
    )

    if (callers.length > 0) {
      const callerLines = callers.slice(0, 15).map((c) => {
        const sym = callerMap.get(c.callerName)
        const sig = sym?.signature ? `: ${sym.signature}` : ''
        return `  - ${c.callerName} (${c.callerFile}:${c.line + 1})${sig}`
      })
      sections.push(
        `Data flows IN from — callers (${callers.length}${callers.length > 15 ? ', showing first 15' : ''}):\n${callerLines.join('\n')}`,
      )
    } else {
      sections.push(
        `Data flows IN from: (no callers found — may be an entry point)`,
      )
    }

    if (outboundCalls.length > 0) {
      const calleeLines = outboundCalls.slice(0, 15).map((c) => {
        if (c.callee_id || c.imports_id) {
          const sym = calleeMap.get(c.callee_id ?? c.imports_id)
          const sig = sym?.signature ? `: ${sym.signature}` : ''
          const loc = sym ? `(${sym.file_path}:${sym.line + 1})` : '(resolved)'
          return `  - ${c.callee_name} ${loc}${sig}`
        }
        const callLine =
          c.call_line != null ? ` at line ${c.call_line + 1}` : ''
        return `  - ${c.callee_name} (unresolved${callLine})`
      })
      sections.push(
        `Data flows OUT to — callees (${outboundCalls.length}${outboundCalls.length > 15 ? ', showing first 15' : ''}):\n${calleeLines.join('\n')}`,
      )
    } else {
      sections.push(`Data flows OUT to: (no outbound calls recorded)`)
    }

    const warning =
      'NOTE: Call-chain and type-signature level only — no variable tracking available. Callers/callees shown are structural, not runtime paths.\n\n'
    const output = warning + sections.join('\n\n')

    const allFilePaths = new Set([
      ...candidates.map((c) => c.file_path),
      ...callerSymbols.map((s) => s.file_path),
      ...calleeOrImportSymbolsFlattened.map((s) => s.file_path ?? ''),
    ])
    await updateUsage(
      'analyze_change_impact',
      Array.from(allFilePaths),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error tracing data flow: ${err}` }],
      isError: true,
    }
  }
}
