import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import type { IndexedFile } from 'src/database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to traverse the call graph inbound and/or outbound from a symbol, up to a configurable depth. */
export function registerTraceCallGraphTool(server: McpServer) {
  server.registerTool(
    'trace_call_graph',
    {
      title: 'Trace Call Graph',
      description:
        'Trace the call graph from a named symbol as an indented ASCII tree with file:line references, ' +
        'up to a configurable depth. ' +
        '\n\n' +
        'THREE DIRECTIONS: ' +
        '`inbound` — who calls this symbol (BFS up the call chain). Use to understand usage and blast radius as a tree. ' +
        '`outbound` — what this symbol calls (BFS down into its dependencies). Use to understand what an implementation does. ' +
        '`both` — full picture in one call; outbound tree first, then inbound tree. ' +
        '\n\n' +
        'OUTPUT FORMAT: ASCII tree using `├─` / `└─` connectors. Each node shows symbol name and file:line. ' +
        '`[cycle]` marks a node that was already visited — it is not expanded further to prevent infinite loops. ' +
        'Unresolved calls (external/builtins) are shown with "(unresolved or inbuilt command at line N)". ' +
        '\n\n' +
        'COMPARE WITH OTHER TOOLS: ' +
        '`get_blast_radius` gives the same inbound BFS as a flat deduplicated list — simpler when you just need the count/names. ' +
        '`trace_data_flow` focuses on the type signature boundary (what types flow in/out) rather than the call tree structure. ' +
        '`explore_codebase` renders the same call relationships as a Mermaid diagram across the whole codebase. ' +
        '\n\n' +
        'Provide `file_path_or_file_name` when multiple symbols share the same name.',
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

        const visitedOut = new Set<string>()
        const visitedIn = new Set<string>()

        const lines: string[] = []

        // Resolve file record once; shared by both directions
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

        if (dir === 'outbound' || dir === 'both') {
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
          const inboundSymbols = await store.searchSymbols(
            name,
            undefined,
            fileRecord?.path,
            5,
          )
          if (inboundSymbols.length === 0) {
            lines.push(`Inbound: symbol '${name}' not found in index.`)
          } else {
            const inboundTarget = inboundSymbols[0]!
            if (inboundSymbols.length > 1 && !file_path_or_file_name) {
              lines.push(
                `Note: ${inboundSymbols.length} symbols named '${name}' found; using first match (${inboundTarget.file_path}:${inboundTarget.line + 1}). Provide file_path to disambiguate.\n`,
              )
            }
            lines.push(
              `Inbound call graph for: ${inboundTarget.name} (${inboundTarget.file_path}:${inboundTarget.line + 1})`,
            )

            await buildInbound(
              store,
              inboundTarget.name,
              inboundTarget.file_path,
              inboundTarget.line + 1,
              0,
              maxDepth,
              visitedIn,
              lines,
              '',
            )
          }
        }

        // usage computation
        const filePathsOut = (
          await store.getSymbolsByIds(Array.from(visitedOut))
        ).map((def) => def.file_path)
        const filePathsIn = (
          await store.getSymbolsByNames(Array.from(visitedIn))
        ).map((def) => def.file_path)
        const uniqueFilePaths = new Set([...filePathsOut, ...filePathsIn])

        const output = lines.join('\n')
        await updateUsage(
          'trace_call_graph',
          Array.from(uniqueFilePaths),
          output.length,
        )

        return {
          content: [{ type: 'text', text: output }],
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

/** Builds and visualizes the outbound call relationships starting from a given symbol, recursively tracing dependencies while avoiding cycles and respecting depth limits. Children of a symbol are rendered as intermediate tree nodes, with their own calls nested beneath them. */
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
  if (currentDepth === 0) {
    lines.push(`${symbolName} (${filePath}:${lineNum})`)
  }

  if (visited.has(symbolId)) return
  visited.add(symbolId)

  if (currentDepth >= maxDepth) return

  const [directCalls, children] = await Promise.all([
    store.getCallsForSymbols([symbolId]),
    store.getChildSymbols(symbolId),
  ])

  // Pre-filter children to only those with outbound calls
  const childrenWithCalls = await Promise.all(
    children.map(async (child) => {
      const childCalls = await store.getCallsForSymbols([child.id])
      return childCalls.length > 0 ? child : null
    }),
  ).then((results) => results.filter((c) => c !== null))

  const totalItems = directCalls.length + childrenWithCalls.length
  if (totalItems === 0) return

  // Render direct calls made by this symbol
  for (let i = 0; i < directCalls.length; i++) {
    const call = directCalls[i]!
    const isLast = i === totalItems - 1
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

  // Render each child symbol as an intermediate node (pre-filtered to those with outbound calls)
  for (let i = 0; i < childrenWithCalls.length; i++) {
    const child = childrenWithCalls[i]!
    const isLast = directCalls.length + i === totalItems - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')

    lines.push(
      `${prefix}${connector} ${child.name} (${child.file_path}:${child.line + 1})`,
    )
    await buildOutbound(
      store,
      child.id,
      child.name,
      child.file_path,
      child.line + 1,
      currentDepth + 1,
      maxDepth,
      visited,
      lines,
      childPrefix,
    )
  }
}

/** Builds a hierarchical inbound call graph. Direct callers are listed first; then each child symbol
 * that has callers is rendered as an intermediate node with its callers nested beneath it. */
async function buildInbound(
  store: IndexerDB,
  symbolName: string,
  filePath: string,
  lineNum: number,
  currentDepth: number,
  maxDepth: number,
  visited: Set<string>,
  lines: string[],
  prefix: string,
): Promise<void> {
  if (currentDepth === 0) {
    lines.push(`${symbolName} (${filePath}:${lineNum})`)
  }

  if (visited.has(symbolName)) return
  visited.add(symbolName)

  if (currentDepth >= maxDepth) return

  const callers = await store.getCallersNested(symbolName)
  if (callers.length === 0) return

  // Separate direct callers (childName == null) from callers-via-children
  const directCallers: Array<{
    callerFile: string
    callerName: string
    line: number
  }> = []
  const childGroups = new Map<
    string,
    {
      childFilePath: string
      childLine: number
      callers: Array<{ callerFile: string; callerName: string; line: number }>
    }
  >()
  const seenDirect = new Set<string>()
  const seenChildCallers = new Map<string, Set<string>>()

  for (const c of callers) {
    if (c.childName === null) {
      const key = `${c.callerName}|${c.callerFile}`
      if (!seenDirect.has(key)) {
        seenDirect.add(key)
        directCallers.push({
          callerFile: c.callerFile,
          callerName: c.callerName,
          line: c.line,
        })
      }
    } else {
      if (!childGroups.has(c.childName)) {
        childGroups.set(c.childName, {
          childFilePath: c.childFilePath!,
          childLine: c.childLine!,
          callers: [],
        })
        seenChildCallers.set(c.childName, new Set())
      }
      const callerKey = `${c.callerName}|${c.callerFile}`
      if (!seenChildCallers.get(c.childName)!.has(callerKey)) {
        seenChildCallers.get(c.childName)!.add(callerKey)
        childGroups.get(c.childName)!.callers.push({
          callerFile: c.callerFile,
          callerName: c.callerName,
          line: c.line,
        })
      }
    }
  }

  const totalItems = directCallers.length + childGroups.size
  let itemIndex = 0

  // Render direct callers of this symbol
  for (const caller of directCallers) {
    const isLast = itemIndex === totalItems - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')

    if (visited.has(caller.callerName)) {
      lines.push(
        `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1}) [cycle]`,
      )
    } else {
      lines.push(
        `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1})`,
      )
      await buildInbound(
        store,
        caller.callerName,
        caller.callerFile,
        caller.line + 1,
        currentDepth + 1,
        maxDepth,
        visited,
        lines,
        childPrefix,
      )
    }
    itemIndex++
  }

  // Render each child with callers as an intermediate node
  for (const [
    childName,
    { childFilePath, childLine, callers: childCallers },
  ] of childGroups) {
    const isLast = itemIndex === totalItems - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')

    lines.push(
      `${prefix}${connector} ${childName} (${childFilePath}:${childLine + 1})`,
    )

    for (let j = 0; j < childCallers.length; j++) {
      const caller = childCallers[j]!
      const isLastCaller = j === childCallers.length - 1
      const callerConnector = isLastCaller ? '└─' : '├─'
      const callerPrefix = childPrefix + (isLastCaller ? '   ' : '│  ')

      if (visited.has(caller.callerName)) {
        lines.push(
          `${childPrefix}${callerConnector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1}) [cycle]`,
        )
      } else {
        lines.push(
          `${childPrefix}${callerConnector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1})`,
        )
        await buildInbound(
          store,
          caller.callerName,
          caller.callerFile,
          caller.line + 1,
          currentDepth + 1,
          maxDepth,
          visited,
          lines,
          callerPrefix,
        )
      }
    }
    itemIndex++
  }
}
