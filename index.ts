#!/usr/bin/env bun
import { parseArgs } from 'util'
import { startMcpServer } from './src/server'
import { IndexPipeline } from './src/indexer/IndexPipeline'
import { IndexerDB } from './src/database/IndexerDB'
import type { SymbolKind } from './src/config/types'
import { logWarning } from 'src/utils/logger'

declare module 'bun' {
  interface Env {
    NODE_ENV?: string
    LOG_LEVEL?: string
    DB_FILE_URL?: string
    DB_MIGRATIONS_DIR?: string
  }
}

const { values, positionals } = parseArgs({
  args: Bun.argv,
  options: {
    cwd: {
      type: 'string',
    },
    query: {
      type: 'string',
      short: 'q',
    },
    kind: {
      type: 'string',
      short: 'k',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
  },
  strict: true,
  allowPositionals: true,
})

const command = positionals[2] // e.g. bun run index.ts <command>

const cwd = values.cwd || process.cwd()

if (values.help || !command) {
  logWarning(`
Usage: agentic-indexer <command> [options]

Commands:
  serve       Run the MCP server (reads over stdio)
  index       Run a one-off index of the workspace
  query       Query the existing index from CLI

Options:
  --cwd       Workspace directory (default: current directory)
  -q, --query Search query pattern (e.g. "auth*")
  -k, --kind  Filter by symbol kind (e.g. "function")
  -h, --help  Show this help message
  `)
  process.exit(values.help ? 0 : 1)
}

async function main() {
  switch (command) {
    case 'serve':
      await startMcpServer(cwd)
      break
    case 'index': {
      logWarning(`Running index on ${cwd}`)
      const dbPath = `${cwd}/.agentic/index/symbols.sqlite`
      const store = IndexerDB.getInstance(dbPath)
      await store.init()

      const pipeline = new IndexPipeline({
        cwd,
        store,
        extensions: ['ts', 'js', 'tsx', 'jsx'],
        ignorePatterns: ['node_modules', '.git', 'dist', 'build'],
      })

      await pipeline.run()
      break
    }
    case 'query': {
      if (!values.query) {
        console.error('Error: --query is required for the query command')
        process.exit(1)
      }

      const dbPath = `${cwd}/.agentic/index/symbols.sqlite`
      const store = IndexerDB.getInstance(dbPath)
      await store.init()

      logWarning(`Searching for "${values.query}" in ${cwd}...`)
      const results = await store.searchSymbols(
        values.query,
        values.kind as SymbolKind | 'all',
        undefined,
        50,
      )

      if (results.length === 0) {
        logWarning('No results found.')
      } else {
        logWarning(`Found ${results.length} results:\n`)
        for (const r of results) {
          logWarning(`[${r.kind.toUpperCase()}] ${r.name}`)
          logWarning(`  File: ${r.file_path}:${r.line + 1}`)
          if (r.signature) logWarning(`  Signature: ${r.signature}`)
        }
      }
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
