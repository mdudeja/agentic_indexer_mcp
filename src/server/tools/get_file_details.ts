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
        file_path_or_file_name: z
          .string()
          .describe(
            'File name or File path relative to workspace root. Supports partial file name or file path matches.',
          ),
        include_private: z
          .boolean()
          .default(true)
          .describe(
            'When false, returns only exported symbols and public members of exported types. Default true returns all symbols.',
          ),
        include_lexical_declarations: z
          .boolean()
          .default(false)
          .describe(
            'When true, includes symbols like constants, variables, and type aliases that are not exported but are still important for understanding the file contents. Default false focuses on functions, methods and classes.',
          ),
      }),
    },
    async ({
      file_path_or_file_name,
      include_private,
      include_lexical_declarations,
    }) => {
      const store = IndexerDB.getInstance()
      try {
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
                text: `Multiple files found matching "${file_path_or_file_name}". Please specify a more specific path or use the file ID:\n${fileList}`,
              },
            ],
          }
        }

        const fileRecord = files[0]

        const allSymbols = await store.getSymbolsForFile(fileRecord!.path)

        if (allSymbols.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No symbols found or file not indexed: ${file_path_or_file_name}`,
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

        if (!include_lexical_declarations) {
          symbols = symbols.filter((s) => {
            if (
              s.kind === 'const' ||
              s.kind === 'let' ||
              s.kind === 'var' ||
              s.kind === 'type' ||
              s.kind === 'interface'
            ) {
              return s.exported
            }
            return true
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
            if (s.parameters_json) {
              try {
                const params = JSON.parse(s.parameters_json)
                line += `\n    Parameters: ${params
                  .map((p: any) => `${p.name}: ${p.type}`)
                  .join(', ')}`
              } catch (e) {
                // Ignore JSON parsing errors
              }
            }
            if (s.return_type) {
              line += `\n    Returns: ${s.return_type}`
            }
            return line
          })
          sections.push(`## ${kind.toUpperCase()}\n${lines.join('\n')}`)
        }

        const header = `File: ${fileRecord!.path}\nExported: ${exportedCount} / Total: ${totalCount}${!include_private ? ' (showing public interface only)' : ''}\n`
        return {
          content: [
            { type: 'text', text: header + '\n' + sections.join('\n\n') },
          ],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `Error getting file details: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
