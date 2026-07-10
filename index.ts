#!/usr/bin/env bun
import { parseArgs } from 'util'
import { startMcpServer, stopMcpServer } from './src/server'
import { IndexPipeline } from './src/indexer/IndexPipeline'
import { IndexerDB } from './src/database/IndexerDB'
import type { SymbolKind } from './src/config/types'
import { logWarning } from 'src/utils/logger'
import { resolvePath, resolveWorkspacePath } from 'src/utils/paths'
import { loadConfig, saveConfig } from 'src/config/loader'
import { AppStateManager } from 'src/state'
import { version } from './package.json'

/** The module 'bun' provides a set of environment variables for configuring application settings, including logging, database access, and API keys for services like Claude, Gemini, and OpenAI. */
declare module 'bun' {
  interface Env {
    AGENTIC_DIR?: string
    CONFIG_FILENAME?: string
    NODE_ENV?: string
    LOG_LEVEL?: string
    DB_FILE_URL?: string
    BUILD_VERSION?: string
    DB_MIGRATIONS_DIR?: string
    CLAUDE_API_KEY?: string
    GEMINI_API_KEY?: string
    OPENAI_API_KEY?: string
    TEST_FIXTURES_DIR?: string
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
    includeGitIgnored: {
      type: 'boolean',
      short: 'g',
    },
    file: {
      type: 'string',
    },
    force: {
      type: 'boolean',
      short: 'f',
    },
    version: {
      type: 'boolean',
    },
  },
  strict: true,
  allowPositionals: true,
})

const command = positionals[2] // e.g. bun run index.ts <command>

const cwd = resolvePath(values.cwd ?? process.cwd())

if (values.version) {
  console.log(`agentic-indexer version: ${version}`)
  process.exit(0)
}

if (values.help || !command) {
  logWarning(`
Usage: agentic-indexer <command> [options]

Commands:
  init                Initialize the workspace (create config file)
  index               Run a one-off index of the workspace
  serve               Run the MCP server (reads over stdio)
  stop                Stop the MCP server
  enhance             Run a one-off enhancement of the workspace
  index-file          Index a single file (provide path via --file option)
  enhance-file        Enhance the symbol information for a single file (provide path via --file option)
  remove-docstrings   Remove all generated docstrings from source files and database
  query               Query the existing index from CLI

Options:
  --cwd                       Workspace directory (default: current directory)
  -q,   --query               Search query pattern (e.g. "auth*")
  -k,   --kind                Filter by symbol kind (e.g. "function")
  -h,   --help                Show this help message
  -g,  --include-gitignored   Include files ignored by .gitignore (default: false)
  --file                      Path to a single file to index (required for index-file command)
  --version                   Show the version of the agentic-indexer and exit
  `)
  process.exit(values.help ? 0 : 1)
}

/** The main function serves as the entry point for executing various tasks such as serving, indexing files, querying data, or managing configurations. It processes commands and orchestrates the necessary setup and operations based on the specified command. */
async function main() {
  const config = await loadConfig(cwd)
  AppStateManager.getInstance().setItem('config', config)
  AppStateManager.getInstance().setItem('root', cwd)
  AppStateManager.getInstance().setItem(
    'includeGitIgnored',
    values.includeGitIgnored ?? false,
  )

  const store = IndexerDB.getInstance()
  await store.init()

  switch (command) {
    case 'serve':
      await startMcpServer()
      break

    case 'stop':
      await stopMcpServer()
      process.exit(0)

    case 'index': {
      await saveConfig(cwd, config)
      logWarning(`Running index on ${cwd}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
      })

      await pipeline.run()
      process.exit(0)
    }

    case 'init': {
      await saveConfig(cwd, config)
      process.exit(0)
    }

    case 'enhance': {
      logWarning(`Running enhancement on ${cwd}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
      })

      await pipeline.runEnhancementStep([])
      process.exit(0)
    }

    case 'index-file': {
      if (!values.file) {
        console.error('Error: --file is required for the index-file command')
        process.exit(1)
      }

      const absPath = resolveWorkspacePath(values.file)
      logWarning(`Indexing single file: ${absPath}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
      })

      await pipeline.runOnFile(absPath)
      break
    }

    case 'enhance-file': {
      if (!values.file) {
        console.error('Error: --file is required for the enhance-file command')
        process.exit(1)
      }

      const absPath = resolveWorkspacePath(values.file)
      logWarning(`Enhancing single file: ${absPath}`)
      const pipeline = new IndexPipeline({
        cwd,
        store,
      })

      await pipeline.enhanceFile(absPath)
      break
    }

    case 'remove-docstrings': {
      const pipeline = new IndexPipeline({
        cwd,
        store,
      })
      await pipeline.removeAllDocstrings(store)
      break
    }

    case 'query': {
      if (!values.query) {
        console.error('Error: --query is required for the query command')
        process.exit(1)
      }

      logWarning(`Searching for "${values.query}" in ${cwd}...`)
      const results = await store.symbols.search(
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

process.on('exit', async (code) => {
  logWarning(`Process exiting with code ${code}`)
  await stopMcpServer()
})

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
