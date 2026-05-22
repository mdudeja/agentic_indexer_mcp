import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { like } from 'drizzle-orm'
import * as schema from '../../database/schemas'
import type { SymbolKind } from '../../database/schemas'

/** Registers a tool to find a type/interface definition and all symbols that produce or consume it. */
export function registerResolveTypeTool(server: McpServer) {
  server.registerTool(
    'resolve_type',
    {
      title: 'Resolve Type',
      description:
        'Find the definition of a type or interface and all symbols that produce (return) or consume (accept as parameter) it. Useful for understanding type flow when debugging type errors or unfamiliar data shapes.',
      inputSchema: z.object({
        type_name: z.string().describe('Name of the type or interface to resolve'),
      }),
    },
    async ({ type_name }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = type_name as string
        const db = store.getDb()

        // Find type and interface definitions
        const [typeMatches, ifaceMatches] = await Promise.all([
          store.searchSymbols(name, 'type' as SymbolKind, undefined, 10),
          store.searchSymbols(name, 'interface' as SymbolKind, undefined, 10),
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
          .where(like(schema.symbols.return_type, `%${name}%`))
          .limit(20)

        // Find symbols that consume this type (parameters_json contains the name)
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
          .where(like(schema.symbols.parameters_json, `%${name}%`))
          .limit(20)

        const sections: string[] = []

        // Definitions section
        if (definitions.length > 0) {
          const defLines = definitions.map((d) => {
            let line = `  [${d.kind.toUpperCase()}] ${d.name} in ${d.file_path}:${d.line + 1}`
            if (d.exported) line += ' [exported]'
            if (d.signature) line += `\n  Signature: ${d.signature}`
            return line
          })
          sections.push(`Definition (${definitions.length} found):\n${defLines.join('\n')}`)
        } else {
          sections.push(`Definition: not found in index (may be from an external library)`)
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
                const params = JSON.parse(c.parameters_json) as Array<{ name: string; type?: string }>
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

        return {
          content: [
            {
              type: 'text',
              text: `Type: ${name}\n\n${sections.join('\n\n')}`,
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
