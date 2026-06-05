import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'
import { logDebug } from 'src/utils/logger'

/** Registers a tool to find all references to a symbol — both call sites and import locations. Supersedes find_importers with symbol-level precision. */
export function registerFindSymbolReferencesTool(server: McpServer) {
  server.registerTool(
    'find_symbol_references',
    {
      title: 'Find Symbol References',
      description:
        'Find all places in the codebase that reference a symbol — call sites where it is invoked, files that import it by name, and files that import its containing module. Pass a file path (with / or .) to find module-level importers.',
      inputSchema: z.object({
        symbol_name: z
          .string()
          .describe(
            'Symbol name to find references for, or a file path (containing / or .) to find module importers.',
          ),
        include_imports: z
          .boolean()
          .default(true)
          .describe('Include files that import this symbol by name'),
        include_calls: z
          .boolean()
          .default(true)
          .describe('Include call sites where this symbol is invoked'),
      }),
    },
    async ({ symbol_name, include_imports, include_calls }) => {
      const store = IndexerDB.getInstance()
      try {
        const name = symbol_name as string
        const sections: string[] = []

        if (include_calls) {
          const allCallers = await store.getCallersNested(name)
          if (allCallers.length > 0) {
            const callLines = allCallers.map(
              (c) =>
                `  - ${c.callerName}${c.childName ? ` (${name}.${c.childName})` : ''} in ${c.callerFile}:${c.line + 1}`,
            )
            sections.push(
              `Called at (${allCallers.length} location${allCallers.length !== 1 ? 's' : ''}):\n${callLines.join('\n')}`,
            )
          } else {
            sections.push(`Called at: (none found)`)
          }
        }

        if (include_imports) {
          const importRefs = await store.getImportsByName(name)
          if (importRefs.length > 0) {
            const importLines = importRefs.map(
              (i) => `  - ${i.file_path} (from '${i.module_path}')`,
            )
            sections.push(
              `Imported by name in (${importRefs.length} file${importRefs.length !== 1 ? 's' : ''}):\n${importLines.join('\n')}`,
            )
          } else {
            sections.push(`Imported by name: (none found)`)
          }
        }

        // Module-level importers when name looks like a path
        if (name.includes('/') || name.includes('.')) {
          const cleanedName = name.replace(/\//g, '').replace(/\.[\w]+$/g, '')
          logDebug(`Finding module importers for cleaned name: ${cleanedName}`)
          const moduleImporters = await store.getImporters(cleanedName)
          if (moduleImporters.length > 0) {
            const modLines = [
              ...new Set(moduleImporters.map((i) => i.file_path)),
            ].map((p) => `  - ${p}`)
            sections.push(
              `Module imported by (${modLines.length} file${modLines.length !== 1 ? 's' : ''}):\n${modLines.join('\n')}`,
            )
          } else {
            sections.push(`Module imported by: (none found)`)
          }
        }

        if (sections.length === 0) {
          return {
            content: [
              { type: 'text', text: `No references found for: ${name}` },
            ],
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: `References to: ${name}\n\n${sections.join('\n\n')}`,
            },
          ],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error finding references: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
