import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import type { IndexedFile } from 'src/database/schemas'

/** Registers a tool to traverse the call graph inbound and/or outbound from a symbol, up to a configurable depth. */
export function registerTraceCallGraphTool(server: McpServer) {
  server.registerTool(
    'trace_call_graph',
    {
      title: 'Trace Call Graph',
      description:
        'Trace the call graph from a symbol — who calls it (inbound), what it calls (outbound), or both. Returns an indented tree with file:line references. Essential for understanding execution flow when debugging a tricky problem.',
      inputSchema: z.object({
        symbol_name: z.string().describe('Name of the symbol to start from'),
        direction: z
          .enum(['inbound', 'outbound', 'both'])
          .describe(
            'inbound = who calls this symbol; outbound = what this symbol calls; both = full graph',
          ),
        depth: z
          .number()
          .default(3)
          .describe('Maximum traversal depth (default 3)'),
        file_path_or_file_name: z
          .string()
          .optional()
          .describe(
            'Optional File name or File path relative to workspace root. Supports partial file name or file path matches. Used to disambiguate when multiple symbols share the name',
          ),
      }),
    },
    async ({ symbol_name, direction, depth, file_path_or_file_name }) => {
      const store = IndexerDB.getInstance()
      try {
        const maxDepth = (depth as number) ?? 3
        const dir = direction as 'inbound' | 'outbound' | 'both'
        const name = symbol_name as string

        const lines: string[] = []

        if (dir === 'outbound' || dir === 'both') {
          let fileRecord: IndexedFile['Select'] | null = null
          if (file_path_or_file_name) {
            const files = await store.getFileByPartialNameOrPath(
              file_path_or_file_name,
            )
            if (files.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No file found matching: ${file_path_or_file_name}`,
                  },
                ],
              }
            }
            if (files.length > 1) {
              const fileList = files.map((f) => `  - ${f.path}`).join('\n')
              return {
                content: [
                  {
                    type: 'text',
                    text: `Multiple files found matching '${file_path_or_file_name}':\n${fileList}\nPlease provide a more specific file path or name to disambiguate.`,
                  },
                ],
              }
            }
            fileRecord = files[0] ?? null
          }
          const startSymbols = await store.searchSymbols(
            name,
            undefined,
            fileRecord?.path,
            5,
          )

          if (startSymbols.length === 0) {
            lines.push(`Outbound: symbol '${name}' not found in index.`)
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
            }
          }

          const target = startSymbols[0]!
          if (startSymbols.length > 1 && !file_path_or_file_name) {
            lines.push(
              `Note: ${startSymbols.length} symbols named '${name}' found; using first match (${target.file_path}:${target.line + 1}). Provide file_path to disambiguate.\n`,
            )
          }
          lines.push(
            `Outbound call graph for: ${name} (${target.file_path}:${target.line + 1})`,
          )
          const visitedOut = new Set<string>()
          await buildOutbound(
            store,
            target.id,
            name,
            target.file_path,
            target.line + 1,
            0,
            maxDepth,
            visitedOut,
            lines,
            '',
          )
        }

        if (dir === 'both') lines.push('')

        if (dir === 'inbound' || dir === 'both') {
          lines.push(`Inbound call graph for: ${name}`)
          const visitedIn = new Set<string>()
          await buildInbound(store, name, 0, maxDepth, visitedIn, lines, '')
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error tracing call graph: ${err}` }],
          isError: true,
        }
      }
    },
  )
}

/** Builds and visualizes the outbound call relationships starting from a given symbol, recursively tracing dependencies while avoiding cycles and respecting depth limits. The visualization uses lines and connectors to represent hierarchical calls. */
async function buildOutbound(
  store: IndexerDB,
  symbolId: string,
  symbolName: string,
  filePath: string,
  lineNum: number,
  currentDepth: number,
  maxDepth: number,
  visited: Set<string>,
  lines: string[],
  prefix: string,
): Promise<void> {
  const nodeLabel = `${symbolName} (${filePath}:${lineNum})`

  if (currentDepth === 0) {
    lines.push(nodeLabel)
  }

  if (visited.has(symbolId)) return
  visited.add(symbolId)

  if (currentDepth >= maxDepth) return

  const calls = await store.getCallsForSymbols([symbolId])
  if (calls.length === 0) return

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!
    const isLast = i === calls.length - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')
    const docstringNote = call.docstring ? ` [${call.docstring}]` : ''

    if (call.callee_id) {
      if (visited.has(call.callee_id)) {
        lines.push(
          `${prefix}${connector} ${call.callee_name} [cycle] ${docstringNote}`,
        )
        continue
      }
      const callee = await store.getDefinition(call.callee_id)
      if (callee) {
        lines.push(
          `${prefix}${connector} ${callee.name} (${callee.file_path}:${callee.line + 1}) ${docstringNote}`,
        )
        await buildOutbound(
          store,
          callee.id,
          callee.name,
          callee.file_path,
          callee.line + 1,
          currentDepth + 1,
          maxDepth,
          visited,
          lines,
          childPrefix,
        )
        continue
      }

      lines.push(
        `${prefix}${connector} ${call.callee_name} (broken link) ${docstringNote}`,
      )
      continue
    }

    if (call.imports_id) {
      const imp = await store.getImportById(call.imports_id)
      if (imp) {
        lines.push(
          `${prefix}${connector} ${call.callee_name} (${imp.imported_name} from ${imp.module_path}) ${docstringNote}`,
        )

        continue
      }

      lines.push(
        `${prefix}${connector} ${call.callee_name} (unresolved import) ${docstringNote}`,
      )
      continue
    }

    const callLine =
      call.call_line != null ? ` at line ${call.call_line + 1}` : ''
    lines.push(
      `${prefix}${connector} ${call.callee_name} (unresolved or inbuilt command${callLine}) ${docstringNote}`,
    )
  }
}

/** Builds a hierarchical list of all call sites for a given symbol, exploring caller relationships recursively. Handles cycles and limits traversal depth based on configuration. */
async function buildInbound(
  store: IndexerDB,
  symbolName: string,
  currentDepth: number,
  maxDepth: number,
  visited: Set<string>,
  lines: string[],
  prefix: string,
): Promise<void> {
  if (currentDepth === 0) {
    lines.push(symbolName)
  }

  if (visited.has(symbolName)) return
  visited.add(symbolName)

  if (currentDepth >= maxDepth) return

  const callers = await store.getCallers(symbolName)
  if (callers.length === 0) return

  // Deduplicate by callerName+callerFile
  const seen = new Set<string>()
  const unique = callers.filter((c) => {
    const key = `${c.callerName}|${c.callerFile}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  for (let i = 0; i < unique.length; i++) {
    const caller = unique[i]!
    const isLast = i === unique.length - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')

    if (visited.has(caller.callerName)) {
      lines.push(
        `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1}) [cycle]`,
      )
      continue
    }

    lines.push(
      `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1})`,
    )
    await buildInbound(
      store,
      caller.callerName,
      currentDepth + 1,
      maxDepth,
      visited,
      lines,
      childPrefix,
    )
  }
}
