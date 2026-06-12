import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { inArray } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to show call-chain and type-level data flow through a symbol. */
export function registerTraceDataFlowTool(server: McpServer) {
  server.registerTool(
    'trace_data_flow',
    {
      title: 'Trace Data Flow',
      description:
        'Show the type-level data boundary of a function: what types flow in (parameters), what type flows out (return), ' +
        'which callers pass data into it, and which callees it passes data out to. ' +
        '\n\n' +
        'CRITICAL LIMITATION: This is NOT variable-level data flow. ' +
        'There is no tracking of how a value moves through assignments or transformations inside a function body. ' +
        'It shows the structural I/O boundary and the call-chain context around it, nothing more. ' +
        '\n\n' +
        'WHEN TO USE: To answer "what produces data for this function?" and "where does its output go?" ' +
        'when debugging an unexpected value or tracing a data shape through the call chain. ' +
        'Useful as a quick type-boundary snapshot before reading the full implementation. ' +
        '\n\n' +
        'THREE SECTIONS RETURNED: ' +
        '(1) Symbol header — name, kind, file:line, parameters with types, return type. ' +
        '(2) Data flows IN — callers with their signatures (who passes data into this function). ' +
        '(3) Data flows OUT — callees (what this function hands data to). ' +
        '\n\n' +
        'COMPARE WITH OTHER TOOLS: ' +
        '`trace_call_graph(outbound)` gives the same callees as a deep recursive tree. ' +
        '`resolve_type` maps the type itself — producers and consumers — rather than a specific function. ' +
        'Use `get_definition` after this to read the actual implementation.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe('Function or method name to trace data flow through'),
        file_path: z
          .string()
          .optional()
          .describe(
            'Optional file path to disambiguate when multiple symbols share the name',
          ),
      }),
    },
    async ({ symbol_name, file_path }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = symbol_name as string
        const db = store.getDb()

        const candidates = await store.symbols.search(
          name,
          undefined,
          file_path as string | undefined,
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

        // Parse parameters
        let paramSummary = '(none)'
        if (target.parameters_json) {
          try {
            const params = JSON.parse(target.parameters_json) as Array<{
              name: string
              type?: string
              optional?: boolean
            }>
            paramSummary =
              params.length > 0
                ? params
                    .map(
                      (p) =>
                        `${p.name}${p.optional ? '?' : ''}: ${p.type ?? 'unknown'}`,
                    )
                    .join(', ')
                : '(none)'
          } catch {
            paramSummary = '(could not parse)'
          }
        }

        const returnSummary = target.return_type ?? 'unknown'

        // Producers: who calls this, passing data in
        const callers = await store.calls.getCallers(name)
        let callerSymbols: Array<typeof schema.symbols.$inferSelect> = []
        if (callers.length > 0) {
          const callerNames = [...new Set(callers.map((c) => c.callerName))]
          callerSymbols = await db
            .select()
            .from(schema.symbols)
            .where(inArray(schema.symbols.name, callerNames))
        }
        const callerMap = new Map(callerSymbols.map((s) => [s.name, s]))

        // Consumers: what this calls, passing data out
        const outboundCalls = await store.calls.getForSymbols([target.id])
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
            // For imports, we can create a synthetic symbol record with the module path as the name
            const importRecord = await store.imports.getById(entry.id!)
            if (importRecord) {
              return [
                {
                  id: entry.id,
                  callee_name: importRecord.imported_name,
                  kind: 'import' as const,
                  file_path: importRecord.module_path,
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

        // Target signature
        sections.push(
          `Symbol: ${target.name} [${target.kind}] (${target.file_path}:${target.line + 1})\nParameters: ${paramSummary}\nReturns:    ${returnSummary}`,
        )

        // Callers (data flowing IN)
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

        // Callees (data flowing OUT)
        if (outboundCalls.length > 0) {
          const calleeLines = outboundCalls.slice(0, 15).map((c) => {
            if (c.callee_id || c.imports_id) {
              const sym = calleeMap.get(c.callee_id ?? c.imports_id)
              const sig = sym?.signature ? `: ${sym.signature}` : ''
              const loc = sym
                ? `(${sym.file_path}:${sym.line + 1})`
                : '(resolved)'
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

        //usage computation
        const allFilePaths = new Set([
          ...candidates.map((c) => c.file_path),
          ...callerSymbols.map((s) => s.file_path),
          ...calleeOrImportSymbolsFlattened.map((s) => s.file_path),
        ])
        await updateUsage(
          'trace_data_flow',
          Array.from(allFilePaths),
          output.length,
        )

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error tracing data flow: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
