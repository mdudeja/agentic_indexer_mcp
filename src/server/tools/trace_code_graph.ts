import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { updateUsage } from 'src/utils/updateUsage'
import type { IndexedFile } from 'src/database/schemas'
import type { DirectCaller } from 'src/database/types'
import { resolveFile } from './helpers/symbolLookup'
import { formatResolutionAnnotation } from './helpers/format'

/** Registers the trace_code_graph tool: understand call relationships. */
export function registerTraceCodeGraphTool(server: McpServer) {
  server.registerTool(
    'trace_code_graph',
    {
      title: 'Trace Code Graph',
      description:
        'Understand call relationships and assess impact. ' +
        '\n\n' +
        '`call_graph` traces inbound (who calls X), outbound (what X calls), or both, as an indented ASCII tree with file:line refs (depth-limited). ' +
        '\n\n' +
        'WHEN TO USE: To understand execution topology and assess the impact of changes. ',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .optional()
          .describe('Name of the symbol to start from'),
        direction: z
          .enum(['inbound', 'outbound', 'both'])
          .optional()
          .describe('Direction for call_graph mode (default: both)'),
        depth: z
          .number()
          .default(3)
          .optional()
          .describe('Maximum traversal depth for call_graph mode (default 3)'),
        file_path_or_file_name: z
          .string()
          .optional()
          .describe('File name or path to disambiguate symbols'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()

      if (!args.symbol_name) {
        return {
          content: [
            { type: 'text', text: 'call_graph mode requires symbol_name.' },
          ],
          isError: true,
        }
      }
      return traceCallGraph(
        store,
        args.symbol_name,
        args.direction ?? 'both',
        args.depth ?? 3,
        args.file_path_or_file_name,
      )
    },
  )
}

/** Builds and visualizes the outbound call relationships starting from a given symbol. */
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
    store.callEdges.getOutboundForSymbols([symbolId]),
    store.symbols.getChildSymbols(symbolId),
  ])

  const childrenWithCalls = await Promise.all(
    children.map(async (child) => {
      const childCalls = await store.callEdges.getOutboundForSymbols([child.id])
      return childCalls.length > 0 ? child : null
    }),
  ).then((results) => results.filter((c) => c !== null))

  const totalItems = directCalls.length + childrenWithCalls.length
  if (totalItems === 0) return

  for (let i = 0; i < directCalls.length; i++) {
    const call = directCalls[i]!
    const isLast = i === totalItems - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')
    const docstringNote = call.docstring ? ` [${call.docstring}]` : ''

    if (call.callee_id) {
      const annotation = formatResolutionAnnotation({
        confidence: call.confidence,
        resolutionSource: call.resolution_source,
      })
      if (visited.has(call.callee_id)) {
        lines.push(
          `${prefix}${connector} ${call.callee_name} [cycle]${annotation}`,
        )
        continue
      }
      const callee = await store.symbols.getDefinition(call.callee_id)
      if (callee) {
        lines.push(
          `${prefix}${connector} ${callee.name} (${callee.file_path}:${callee.line + 1})${annotation}${docstringNote}`,
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
        `${prefix}${connector} ${call.callee_name} (broken link)${annotation}`,
      )
      continue
    }

    if (call.imports_id) {
      const imp = await store.imports.getById(call.imports_id)
      if (imp) {
        const annotation = formatResolutionAnnotation({
          confidence: imp.confidence,
          resolutionSource: imp.resolutionSource,
        })
        lines.push(
          `${prefix}${connector} ${call.callee_name} (${imp.importedNames?.join(', ') || '*'} from ${imp.sourceModule})${annotation}${docstringNote}`,
        )
        continue
      }
      lines.push(
        `${prefix}${connector} ${call.callee_name} (unresolved import)${docstringNote}`,
      )
      continue
    }

    const annotation = formatResolutionAnnotation({
      confidence: call.confidence,
      resolutionSource: call.resolution_source,
    })
    const callLine =
      call.call_line != null ? ` at line ${call.call_line + 1}` : ''
    lines.push(
      `${prefix}${connector} ${call.callee_name} (${call.is_lang_feature ? 'language or runner framework feature' : 'possibly unresolved'})${callLine}${annotation}${docstringNote}`,
    )
  }

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

/** Builds a hierarchical inbound call graph. */
async function buildInbound(
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

  const callers = await store.callEdges.getCallersNestedById(symbolId)
  if (callers.length === 0) return

  const directCallers: Array<DirectCaller> = []
  const childGroups = new Map<
    string,
    { childFilePath: string; childLine: number; callers: Array<DirectCaller> }
  >()
  const seenDirect = new Set<string>()
  const seenChildCallers = new Map<string, Set<string>>()

  for (const c of callers) {
    if (c.childName === null) {
      const key = `${c.callerId}`
      if (!seenDirect.has(key)) {
        seenDirect.add(key)
        directCallers.push({
          callerFile: c.callerFile,
          callerName: c.callerName,
          line: c.line,
          callerId: c.callerId,
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
      const callerKey = `${c.callerId}`
      if (!seenChildCallers.get(c.childName)!.has(callerKey)) {
        seenChildCallers.get(c.childName)!.add(callerKey)
        childGroups.get(c.childName)!.callers.push({
          callerFile: c.callerFile,
          callerName: c.callerName,
          line: c.line,
          callerId: c.callerId,
        })
      }
    }
  }

  const totalItems = directCallers.length + childGroups.size
  let itemIndex = 0

  for (const caller of directCallers) {
    const isLast = itemIndex === totalItems - 1
    const connector = isLast ? '└─' : '├─'
    const childPrefix = prefix + (isLast ? '   ' : '│  ')

    if (visited.has(caller.callerId)) {
      lines.push(
        `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1}) [cycle]`,
      )
    } else {
      lines.push(
        `${prefix}${connector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1})`,
      )
      await buildInbound(
        store,
        caller.callerId,
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

      if (visited.has(caller.callerId)) {
        lines.push(
          `${childPrefix}${callerConnector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1}) [cycle]`,
        )
      } else {
        lines.push(
          `${childPrefix}${callerConnector} ${caller.callerName} (${caller.callerFile}:${caller.line + 1})`,
        )
        await buildInbound(
          store,
          caller.callerId,
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

/** Traces the call graph inbound/outbound/both from a symbol. */
async function traceCallGraph(
  store: IndexerDB,
  symbol_name: string,
  direction: 'inbound' | 'outbound' | 'both',
  depth: number,
  file_path_or_file_name?: string,
): Promise<ToolResult> {
  try {
    const maxDepth = depth ?? 3
    const dir = direction
    const name = symbol_name
    const visitedOut = new Set<string>()
    const visitedIn = new Set<string>()
    const lines: string[] = []

    let fileRecord: IndexedFile['Select'] | null = null
    if (file_path_or_file_name) {
      const resolved = await resolveFile(store, file_path_or_file_name)
      if (!resolved.ok) {
        return { content: [{ type: 'text', text: resolved.error }] }
      }
      fileRecord = resolved.file
    }

    if (dir === 'outbound' || dir === 'both') {
      const startSymbols = await store.symbols.search(
        name,
        undefined,
        fileRecord?.path,
        undefined,
        5,
      )
      if (startSymbols.length === 0) {
        lines.push(`Outbound: symbol '${name}' not found in index.`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
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
      const inboundSymbols = await store.symbols.search(
        name,
        undefined,
        fileRecord?.path,
        undefined,
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
          inboundTarget.id,
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

    const filePathsOut = (
      await store.symbols.getSymbolsByIds(Array.from(visitedOut))
    ).map((def) => def.file_path)
    const filePathsIn = (
      await store.symbols.getSymbolsByNames(Array.from(visitedIn))
    ).map((def) => def.file_path)
    const uniqueFilePaths = new Set([...filePathsOut, ...filePathsIn])

    const output = lines.join('\n')
    await updateUsage(
      'trace_code_graph',
      Array.from(uniqueFilePaths),
      output.length,
    )
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error tracing call graph: ${err}` }],
      isError: true,
    }
  }
}
