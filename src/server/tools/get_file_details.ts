import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { IndexerDB } from '../../database/IndexerDB'

/** Registers a tool to retrieve all symbols defined in a file, with optional filtering to exported/public symbols only. */
export function registerGetFileDetailsTool(server: McpServer) {
  server.registerTool(
    'get_file_details',
    {
      title: 'Get File Details',
      description:
        'Get all symbols (functions, classes, variables, etc.) defined in a specific file. Use this tool when you want to understand what a file contains and how it is structured.',
      inputSchema: z.object({
        file_path: z.string().describe('File path relative to workspace root'),
        include_private: z.boolean().default(true).describe(
          'When false, returns only exported symbols and public members of exported types. Default true returns all symbols.',
        ),
      }),
    },
    async ({ file_path, include_private }) => {
      const store = IndexerDB.getInstance()
      try {
        const allSymbols = await store.getSymbolsForFile(file_path as string)

        if (allSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found or file not indexed: ${file_path}`,
              },
            ],
          }
        }

        let symbols = allSymbols

        if (!include_private) {
          const parentMap = new Map(allSymbols.map((s) => [s.id, s]))

          symbols = allSymbols.filter((sym) => {
            if (sym.exported) return true
            if (sym.parent_id) {
              const parent = parentMap.get(sym.parent_id)
              if (
                parent?.exported &&
                !sym.signature?.trimStart().startsWith('private ')
              ) {
                return true
              }
            }
            return false
          })
        }

        const totalCount = allSymbols.length
        const exportedCount = allSymbols.filter((s) => s.exported).length

        // Group by kind
        const byKind = new Map<string, typeof symbols>()
        for (const sym of symbols) {
          const group = byKind.get(sym.kind) ?? []
          group.push(sym)
          byKind.set(sym.kind, group)
        }

        const sections: string[] = []
        for (const [kind, syms] of byKind) {
          const lines = syms.map((s) => {
            let line = `  - ${s.name} (line ${s.line + 1})`
            if (s.exported) line += ' [exported]'
            if (s.signature) line += `\n    Signature: ${s.signature}`
            if (s.docstring) line += `\n    Doc: ${s.docstring.split('\n')[0]}`
            return line
          })
          sections.push(`## ${kind.toUpperCase()}\n${lines.join('\n')}`)
        }

        const header = `File: ${file_path}\nExported: ${exportedCount} / Total: ${totalCount}${!include_private ? ' (showing public interface only)' : ''}\n`
        return {
          content: [{ type: 'text', text: header + '\n' + sections.join('\n\n') }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error getting file details: ${err}` }],
          isError: true,
        }
      }
    },
  )
}
