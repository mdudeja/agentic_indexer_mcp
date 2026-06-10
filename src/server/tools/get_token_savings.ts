import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { IndexerDB } from '../../database/IndexerDB'

/** Registers a tool that reports how many tokens this MCP has saved the user for this codebase. */
export function registerGetTokenSavingsTool(server: McpServer) {
  server.registerTool(
    'get_token_savings',
    {
      title: 'Get Token Savings',
      description:
        'Reports how many context tokens this MCP server has saved you for this codebase. ' +
        'Each tool call avoids the need to load raw source files into your context window — ' +
        'the savings estimate reflects the difference between what you would have had to read ' +
        'and what the tool actually returned. ' +
        '\n\n' +
        'Returns total tokens saved, total tool calls, and a per-tool breakdown sorted by impact.',
      inputSchema: {},
    },
    () => {
      const store = IndexerDB.getInstance()
      try {
        const stats = store.getTokenSavings()

        if (stats.total_calls === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No tool calls recorded yet.',
              },
            ],
          }
        }

        const approxCost = (tokens: number) =>
          ((tokens / 1_000_000) * 3.0).toFixed(4)

        const lines: string[] = [
          '## Token Savings Report',
          '',
          `Total tool calls:    ${stats.total_calls}`,
          `Source tokens read:  ${stats.total_source_tokens.toLocaleString()}`,
          `Response tokens out: ${stats.total_response_tokens.toLocaleString()}`,
          `Tokens saved:        ${stats.total_tokens_saved.toLocaleString()}  (~$${approxCost(stats.total_tokens_saved)} at $3/Mtok)`,
          '',
          '### Per-tool breakdown',
          '',
          `${'Tool'.padEnd(30)} ${'Calls'.padStart(6)} ${'Saved'.padStart(10)} ${'Source'.padStart(10)} ${'Response'.padStart(10)}`,
          `${'-'.repeat(30)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)}`,
        ]

        for (const row of stats.by_tool) {
          lines.push(
            `${row.tool_name.padEnd(30)} ${String(row.calls).padStart(6)} ${row.tokens_saved.toLocaleString().padStart(10)} ${row.source_tokens.toLocaleString().padStart(10)} ${row.response_tokens.toLocaleString().padStart(10)}`,
          )
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Error fetching token savings: ${err}` },
          ],
          isError: true,
        }
      }
    },
  )
}
