import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolResult } from './index'
import { IndexerDB } from 'src/database/IndexerDB'
import { z } from 'zod'
import { AppStateManager } from 'src/state'
import { join } from 'node:path'
import { resolveWorkspacePath } from 'src/utils/paths'
import { updateUsage } from 'src/utils/updateUsage'
import { getNowMillis } from 'src/utils/datetime'

enum AUDIT_MODE {
  agent_config = 'agent_config',
  token_savings = 'token_savings',
  index_health = 'index_health',
}

/** Registers the audit_index tool: index health & analytics. */
export function registerAuditIndexTool(server: McpServer) {
  server.registerTool(
    'audit_index',
    {
      title: 'Audit Index',
      description:
        'Audit the health of the index and review analytics. ' +
        '\n\n' +
        'THREE MODES: ' +
        '`agent_config` — scan AI agent context files (.cursorrules, CLAUDE.md, AGENTS.md, etc.) for stale file paths and symbol references that waste tokens or mislead agents. ' +
        '`token_savings` — report how many context tokens the MCP tools have saved you, with a per-tool breakdown. ' +
        '`index_health` — report index freshness (last indexed time, file/symbol counts) and DB integrity (orphaned rows, unresolved call edges). ' +
        '\n\n' +
        'WHEN TO USE: Run `index_health` to verify the index is current and healthy. ' +
        'Run `agent_config` after any rename/delete/restructure to find stale references. ' +
        'Run `token_savings` to understand the value the tools are providing.',
      inputSchema: z.object({
        mode: z
          .enum(AUDIT_MODE)
          .default(AUDIT_MODE.index_health)
          .describe('What to audit (default: index_health)'),
      }),
    },
    async (args) => {
      const store = IndexerDB.getInstance()
      const mode = args.mode ?? AUDIT_MODE.index_health

      switch (mode) {
        case AUDIT_MODE.agent_config:
          return agentConfig(store)
        case AUDIT_MODE.token_savings:
          return tokenSavings(store)
        case AUDIT_MODE.index_health:
          return indexHealth(store)
        default:
          return {
            content: [{ type: 'text', text: `Unsupported mode: ${mode}` }],
            isError: true,
          }
      }
    },
  )
}

/** Extracts file-path-like tokens from content. */
function extractPathRefs(content: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  const re =
    /(?:^|[\s`'"(])([a-zA-Z][\w./\-]*\/[\w./\-]+(\.\w{1,6})?)(?:$|[\s`'")\]:,])/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const ref = m[1]!.trim()
    if (!seen.has(ref)) {
      seen.add(ref)
      results.push(ref)
    }
  }
  return results
}

/** Extracts backtick-wrapped identifiers from content. */
function extractSymbolRefs(content: string): string[] {
  const seen = new Set<string>()
  const results: string[] = []
  const re = /`([A-Za-z_$][\w$]*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const ref = m[1]!
    if (ref.length < 3) continue
    if (!seen.has(ref)) {
      seen.add(ref)
      results.push(ref)
    }
  }
  return results
}

/** Audits AI agent config files for stale paths and symbol references. */
async function agentConfig(store: IndexerDB): Promise<ToolResult> {
  const AGENT_CONFIG_CANDIDATES =
    AppStateManager.getInstance().getItem('config')?.agent_config_candidates ??
    []

  try {
    const root = AppStateManager.getInstance().getItem('root') ?? process.cwd()

    const allFiles = await store.files.getAll()
    const filePathSet = new Set(allFiles.map((f) => f.path))
    const allSymbols = await store.symbols.getAll()
    const symbolNameSet = new Set(allSymbols.map((s) => s.name))

    const results: string[] = []
    let foundAny = false

    for (const candidate of AGENT_CONFIG_CANDIDATES) {
      const fullPath = resolveWorkspacePath(join(root, candidate))
      const bunFile = Bun.file(fullPath)
      const exists = await bunFile.exists()
      if (!exists) continue

      foundAny = true
      const content = await bunFile.text()
      const tokenEstimate = Math.ceil(content.length / 4)

      const pathRefs = extractPathRefs(content)
      const stalePaths = pathRefs.filter((p) => {
        const normalized = resolveWorkspacePath(p)
        return !filePathSet.has(normalized) && !filePathSet.has(p)
      })

      const symbolRefs = extractSymbolRefs(content)
      const staleSymbols = symbolRefs.filter((s) => !symbolNameSet.has(s))

      results.push(`── ${candidate} (~${tokenEstimate} tokens) ──`)
      if (stalePaths.length === 0 && staleSymbols.length === 0) {
        results.push('  ✓ No stale references detected.')
      } else {
        if (stalePaths.length > 0) {
          results.push(`  Stale paths (${stalePaths.length}):`)
          for (const p of stalePaths) results.push(`    ✗ ${p}`)
        }
        if (staleSymbols.length > 0) {
          results.push(`  Stale symbols (${staleSymbols.length}):`)
          for (const s of staleSymbols) results.push(`    ✗ \`${s}\``)
        }
      }
      results.push('')
    }

    if (!foundAny) {
      return {
        content: [
          {
            type: 'text',
            text: `No agent config files found in ${root}.\nLooked for: ${AGENT_CONFIG_CANDIDATES.join(', ')}`,
          },
        ],
      }
    }

    results.unshift(
      `Agent config audit for ${root}`,
      `Index contains ${allFiles.length} files and ${allSymbols.length} symbols.\n`,
    )

    const output = results.join('\n')
    await updateUsage('audit_index', [], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error auditing agent config: ${err}` }],
      isError: true,
    }
  }
}

/** Reports token savings from tool usage. */
async function tokenSavings(store: IndexerDB): Promise<ToolResult> {
  try {
    const stats = store.toolUsage.getTokenSavings()

    if (stats.total_calls === 0) {
      return {
        content: [{ type: 'text', text: 'No tool calls recorded yet.' }],
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

    return { content: [{ type: 'text', text: lines.join('\n') }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error fetching token savings: ${err}` }],
      isError: true,
    }
  }
}

/** Reports index freshness and DB integrity. */
async function indexHealth(store: IndexerDB): Promise<ToolResult> {
  try {
    const now = getNowMillis()

    const allFiles = await store.files.getAll()
    const allSymbols = await store.symbols.getAll()
    const allImports = await store.imports.getAll()
    const allCallSites = await store.callSites.getForSymbols(
      allSymbols.map((s) => s.id),
    )
    const allCallEdges = await store.callEdges.getForCallers(
      allSymbols.map((s) => s.id),
    )

    // --- Index freshness ---
    const indexedAt = allFiles.map((f) => f.indexed_at)
    const lastIndexed = indexedAt.length > 0 ? Math.max(...indexedAt) : null
    const staleMs = lastIndexed != null ? now - lastIndexed : null
    const staleMinutes = staleMs != null ? Math.floor(staleMs / 60000) : null

    // --- DB integrity ---
    const symbolIds = new Set(allSymbols.map((s) => s.id))
    const filePaths = new Set(allFiles.map((f) => f.path))

    // Orphaned symbols (file_path not in files table)
    const orphanedSymbols = allSymbols.filter(
      (s) => !filePaths.has(s.file_path),
    )

    // Orphaned imports (file_path not in files table)
    const orphanedImports = allImports.filter(
      (i) => !filePaths.has(i.file_path),
    )

    // Unresolved call edges (no callee_id and no imports_id)
    const unresolvedEdges = allCallEdges.filter(
      (e) => e.callee_id == null && e.imports_id == null,
    )

    // Call sites referencing missing caller symbols
    const orphanedCallSites = allCallSites.filter(
      (c) => !symbolIds.has(c.caller_id),
    )

    const lines: string[] = [
      '## Index Health Report',
      '',
      '### Index Freshness',
      `Files indexed:       ${allFiles.length}`,
      `Symbols indexed:     ${allSymbols.length}`,
      `Imports indexed:     ${allImports.length}`,
      `Call sites:          ${allCallSites.length}`,
      `Call edges:          ${allCallEdges.length}`,
      lastIndexed != null
        ? `Last indexed:        ${new Date(lastIndexed).toISOString()} (${staleMinutes} min ago)`
        : 'Last indexed:        never',
      '',
      '### DB Integrity',
      `Orphaned symbols:    ${orphanedSymbols.length}`,
      `Orphaned imports:    ${orphanedImports.length}`,
      `Orphaned call sites: ${orphanedCallSites.length}`,
      `Unresolved call edges: ${unresolvedEdges.length}`,
      '',
    ]

    if (orphanedSymbols.length > 0) {
      lines.push('Orphaned symbols (file not in index):')
      for (const s of orphanedSymbols.slice(0, 10)) {
        lines.push(`  - ${s.name} in ${s.file_path}`)
      }
      lines.push('')
    }
    if (unresolvedEdges.length > 0) {
      lines.push(
        `Note: ${unresolvedEdges.length} call edges are unresolved (no callee or import target). Re-run enhancement to resolve them.`,
      )
    }

    const output = lines.join('\n')
    await updateUsage('audit_index', [], output.length)
    return { content: [{ type: 'text', text: output }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error checking index health: ${err}` }],
      isError: true,
    }
  }
}
