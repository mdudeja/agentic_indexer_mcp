import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { like, or } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import type { SymbolKind } from '../../database/schemas'
import { updateUsage } from 'src/utils/updateUsage'

/** Registers a tool to find a type/interface definition and all symbols that produce or consume it. */
export function registerResolveTypeTool(server: McpServer) {
  server.registerTool(
    'resolve_type',
    {
      title: 'Resolve Type',
      description:
        'Locate a type or interface definition and map out every symbol that produces, consumes, or extends it. ' +
        '\n\n' +
        'FOUR SECTIONS RETURNED: ' +
        '(1) Definition — where the type/interface is declared and its signature. ' +
        '(2) Produced by — functions whose return type contains this type name (approximate LIKE match). ' +
        '(3) Consumed by — functions that accept this type as a parameter (approximate LIKE match). ' +
        '(4) Inheritors — types/interfaces that extend, implement, or compose this type via union/intersection. ' +
        '\n\n' +
        'WHEN TO USE: When you encounter an unfamiliar type and need to know where it comes from, ' +
        'what creates instances of it, and what functions accept or return it. ' +
        'Useful for debugging type errors and tracing data shapes through the codebase. ' +
        '\n\n' +
        'ACCURACY NOTE: Producer and consumer matching uses SQL LIKE on return_type and parameters_json columns. ' +
        'Results may be over-inclusive (a type named `Config` will match `UserConfig`, `ConfigMap`, etc.). ' +
        'Verify against the actual signatures shown in the output. ' +
        '\n\n' +
        'If the type is not found in the index (external library type), the definition section says so but ' +
        'producers, consumers, and inheritors are still searched.',
      inputSchema: z.object({
        type_name: z
          .string()
          .describe(
            'Name of the type or interface to resolve. Supports partial names and wildcards.',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            'Maximum number of producers/consumers to return (default 20)',
          ),
      }),
    },
    async ({ type_name, limit }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = type_name as string
        const db = store.getDb()
        const resultLimit = limit ?? 20

        // Find type and interface definitions
        const [typeMatches, ifaceMatches] = await Promise.all([
          store.symbols.search(name, 'type' as SymbolKind, undefined, 10),
          store.symbols.search(name, 'interface' as SymbolKind, undefined, 10),
        ])
        const definitions = [...typeMatches, ...ifaceMatches]

        // Find symbols that produce this type (return_type contains the name)
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

        // Find symbols that inherit from / extend / union this type
        const inheritors = await store.symbols.getSymbolsInheritingFrom(name)

        const sections: string[] = []

        // Definitions section
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

        // Producers section
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

        // Consumers section
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

        // Inheritors section
        if (inheritors.length > 0) {
          const inheritLines = inheritors.map((i) => {
            const rel = i.inheritence!.find(
              (inh) => inh.inherits_from_name === name,
            )
            return `  [${rel?.inheritence_type?.toUpperCase() ?? 'EXTENDS'}] ${i.name} (${i.kind}) in ${i.file_path}:${i.line + 1}`
          })
          sections.push(
            `Inheritors — types/interfaces extending or composing ${name} (${inheritors.length}):\n${inheritLines.join('\n')}`,
          )
        } else {
          sections.push(`Inheritors: (none found)`)
        }

        const output = `Type: ${name}\n\n${sections.join('\n\n')}`

        // Analytics computation
        const filePaths = new Set([
          ...producers.map((p) => p.file_path),
          ...consumers.map((c) => c.file_path),
          ...inheritors.map((i) => i.file_path),
        ])
        await updateUsage('resolve_type', Array.from(filePaths), output.length)

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
          content: [{ type: 'text', text: `Error resolving type: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
