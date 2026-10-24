# Agentic Indexer MCP

A local code intelligence MCP server for agents. It builds a symbol graph from Tree-sitter and language-server signals, then exposes agent-friendly tools for finding definitions, tracing calls, estimating blast radius, locating tests, and reducing context-window waste.

_Inspired by projects like [jCodeMunch MCP](https://github.com/jgravelle/jcodemunch-mcp)._ but customized for my own workflows, codebases and preferred AI agents.

![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-blue?logo=sqlite)
![Tree-sitter](https://img.shields.io/badge/Tree--sitter-green)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)
![License](https://img.shields.io/badge/License-MIT-green)
![Experimental](https://img.shields.io/badge/Experimental-yellow)

## Current Status
![Active Development](https://img.shields.io/badge/Status-Active%20Development-blue)

### Supported Languages
- TypeScript / JavaScript / TSX
- Python

---

## What the Project Does

Agentic Indexer indexes your local codebase using native AST parsing (via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter)). It extracts symbols—such as functions, classes, methods, and variables—and stores their structured metadata (signatures, docstrings, parameters, return types, and byte offsets) into a local SQLite database along with file hashes.

It then uses LSP to enhance those symbols with additional type information, interfaces/type inheritance, and call-graph links. It also features an AI-based docstring generation step to automatically document undocumented symbols using Claude, Gemini, OpenAI, or Ollama.

When an AI agent (like Claude Desktop, Cursor, Cline, or Windsurf) needs context, it can use this MCP server to query, navigate, and analyze the codebase at symbol-level resolution instead of loading thousands of lines into the context window.

---

## Installation and Usage

### Dependencies and Config
- [Bun](https://bun.sh/) (latest version)
- Language Servers for the languages you want to index (e.g., `typescript-language-server`, `based-pyright`, etc.). The language servers must be available in your system's PATH, or you can specify their absolute paths in `.agentic/config.json` file in your repo.
- Docstring Generation and Embedder need AI Providers to generate docstrings and embeddings. Currently, the following providers are supported:
  - Ollama (local LLMs)
  - OpenAI (GPT-3.5, GPT-4)
  - Claude (Anthropic)
  - Gemini (Google)
- Providers can be configured in `.agentic/config.json` with their respective API keys or local endpoints. For more information about configuring providers and other config parameters, see the [Configuration](#configuration) section below.

### Setup
- Clone the repository and install dependencies:

```bash
git clone https://github.com/mdudeja/agentic_indexer_mcp.git
cd agentic_indexer_mcp
bun install
```

- Copy `.env.template` to `.env` and fill in your API keys for the AI providers you want to use.
- Run the build command to generate an executable in the `dist` folder:

```bash
bun run build
```

- Run bun link to make the MCP server available globally:

```bash
bun link
```

- Go to your project directory and run the index command to build the initial SQLite database:

```bash
cd /path/to/your/project
agentic-indexer index [--cwd /path/to/your/project]
```

- Use the `serve` command in the config file of your preferred AI agent client (Claude Desktop, Cursor, Cline, Windsurf, etc.) to start the MCP server:

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

### Uninstallation
- To uninstall the MCP server, run:
```bash
cd /path/to/agentic_indexer_mcp
bun unlink
```
---

## Configuration

Custom configuration can be specified in `.agentic/config.json` at the root of your workspace. In a new project, you can run the `init` command to generate a default config file:

```bash
agentic-indexer init [--cwd /path/to/your/project]
```

This will create a `.agentic/config.json` file with default settings. You can then edit this file to customize the behavior of the indexer, including enabling or disabling features, specifying ignore patterns, and configuring docstring generation. If the `.env` file in repo directory of MCP server, the config file will have those as well. This way, you have a single source of truth for your API keys and other sensitive information. You can change these in the config.json file of your project if needed. Example (partial) config looks something like this -

```json
{
  "indexer": {
    "debugLogs": false,
    "enabled": true,
    "ignore_patterns": [".git", "node_modules", "dist", "*.lock"],
    "docstring_generation": {
      "enabled": false,
      "provider": "openai",
      "write_to_file": false
    }
  }
}
```
If enabled, `debugLogs` will control whether detailed debug information is written to the log file. Log file is located at `.agentic/logs/indexer_log.txt` within your project directory.

> ⚠️ [!IMPORTANT]
> It is generally a good idea to add `.agentic` directory to your `.gitignore` file to avoid committing sensitive information, generated files, or the database.

Refer to [src/config/default_config.ts] for default settings, including supported language extensions, ignore paths, test file regexes, and entry point patterns.

---

## Architecture

The system operates across three distinct layers:

1. **Parser & Extractor Layer (Tree-Sitter):** Uses `web-tree-sitter` and compiled `.wasm` grammars to parse source files, identifying symbol kinds, imports, and call sites.
2. **Enhancement Layer (LSP):** Uses Language specific `ImportResolver` to resolve imports, `CallSiteResolver` to resolve call sites, `CallEdgeResolver` to resolve call edges, and Server Protocol (LSP) to enhance symbols with additional type information, interfaces/type inheritance, and call-graph links.
3. **Database Layer (Drizzle + Bun SQLite):** Persists metadata, signatures, dependencies, and file hashes to optimize subsequent runs.

---

## MCP Server Tools

The server registers **9 consolidated tools** over `stdio`. Each tool has multiple modes, so agents can pick the right capability without being overwhelmed by a large tool surface.

### 1. `search_codebase` — Find anything
Entry point for locating symbols and files. Auto-detects the best mode from the query (path-like → file listing, >3 words → semantic, else → symbol name search). Supports `*` wildcards and kind/language/file filters.
- **Modes:** `symbol`, `semantic`, `file_compact`, `file_detailed`, `auto`
- **Absorbs:** `search_symbols`, `semantic_search_symbols`, `list_files`, `get_file_details`

### 2. `read_code` — Read source efficiently
Read implementation bodies without loading whole files.
- **Modes:** `definition` (full symbol source), `snippet` (arbitrary line range), `summary` (symbols + imports + importers overview)
- **Absorbs:** `get_definition`, `read_file_snippet`, `get_file_summary`

### 3. `inspect_symbol` — Deep-dive on a single symbol
Understand a symbol deeply before modifying it.
- **Modes:** `definition`, `type_at_location` (LSP), `references`, `importance` (PageRank), `history` (git), `resolve_type`, `class_hierarchy`
- **Absorbs:** `get_definition`, `get_type_at_location`, `find_symbol_references`, `get_symbol_importance`, `get_symbol_history`, `resolve_type`, `get_class_hierarchy`

### 4. `trace_code_graph` — Understand call relationships
Assess impact and understand execution topology. Generates inbound, outbound or both graphs (depth limited)

### 5. `analyze_change_impact` — Risk assessment before a change
Know what could break and what to test before refactoring.
- **Modes:** `blast_radius`, `related_tests`, `required_env_vars`, `error_flow`, `data_flow`
- **Absorbs:** `get_blast_radius`, `find_related_tests`, `get_required_env_vars`, `trace_error_flow`, `trace_data_flow`

### 6. `explore_architecture` — Top-down codebase structure
Orient yourself in an unfamiliar codebase.
- **Modes:** `codebase_map` (directory-grouped topology), `entry_points` (public API surface), `explore` (Mermaid call-graph), `coupling_metrics` (Ce/Ca/I/A/D)
- **Absorbs:** `get_codebase_map`, `get_entry_points`, `explore_codebase`, `get_coupling_metrics`

### 7. `analyze_quality` — Code health assessment
For audits, refactor planning, and test-coverage gaps.
- **Modes:** `dead_code`, `untested_symbols`, `similar_patterns`, `coupling_metrics`, `importance`, `hotspots` (git churn weighted by complexity)
- **Absorbs:** `find_dead_code`, `get_untested_symbols`, `find_similar_patterns`, `get_symbol_importance`, `get_hotspots`

### 8. `inspect_imports` — Import/dependency analysis
Understand module dependencies and resolve import issues.
- **Modes:** `imports_for_file`, `import_by_id`, `dependency_cycles`
- **Absorbs:** `get_imports_for_file`, `get_import_by_id`, `get_dependency_cycles`

### 9. `audit_index` — Index health & analytics
Verify the index is current and healthy.
- **Modes:** `agent_config` (stale paths/symbols in agent config files), `token_savings`, `index_health` (freshness + DB integrity)
- **Absorbs:** `audit_agent_config`, `get_token_savings`, `get_index_health`

---

### CLI Commands

The core commands leverage `index.ts` to manage your environment. All commands support an optional `--cwd` argument to specify the target project directory. If omitted, the current working directory is used.

1. **Index a workspace (One-off Build):**
   Run the initial parser pass on your codebase.

   ```bash
   agentic-indexer index [--cwd /path/to/your/project]
   ```
2. **Init a Workspace:**
   Create a `.agentic/config.json` file in your project root with default settings.

   ```bash
   agentic-indexer init [--cwd /path/to/your/project]
   ```

3. **Index a Single File:**
   Re-index only a specific file.

   ```bash
   agentic-indexer index-file [--cwd /path/to/your/project] --file /path/to/your/file.ts
   ```

4. **Remove Generated Docstrings:**
   Delete all generated docstrings from and database (optionally) source files.

   ```bash
   agentic-indexer remove-docstrings [--cwd /path/to/your/project]
   ```

5. **Query the Index locally:**
   Search for symbols via the CLI.

   ```bash
   agentic-indexer query [--cwd /path/to/your/project] -q "auth*" -k "function"
   ```

6. **Start the MCP Server:**
   Start the stdio MCP server for agent integration.

   ```bash
   agentic-indexer serve [--cwd /path/to/your/project]
   ```

7. **Inspect the MCP Server (while debugging, from within the cloned repo only):**
   Launch the MCP Inspector to debug tools.
   ```bash
   bun run inspect
   ```

---

### Integrating with MCP Clients

Since this server runs over standard I/O (stdio), it can easily be configured as an MCP server in your favorite AI agent client.

#### 1. Claude Desktop

Add the server definition to your Claude Desktop configuration file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

#### 2. Cursor

To use the Agentic Indexer in Cursor:

1. Open Cursor Settings.
2. Navigate to **Features** -> **MCP**.
3. Click **+ Add New MCP Server**.
4. Fill in the following details:
   - **Name:** `agentic-indexer`
   - **Type:** `command`
   - **Command:** `agentic-indexer serve --cwd /path/to/your/project`
5. Click **Save**.

#### 3. Cline / VS Code (Roo Code, Windsurf, etc.)

If you are using VS Code extensions like Cline, Windsurf, or Roo Code, you can add it to their MCP settings configuration file (e.g., `cline_mcp_settings.json` located in your OS global app storage directory):

```json
{
  "mcpServers": {
    "agentic-indexer": {
      "command": "agentic-indexer",
      "args": ["serve", "--cwd", "/path/to/your/project"]
    }
  }
}
```

### Tips for Best Performance & Setup

1. **Pre-Indexing:** Before starting your agent, run a one-off index via `bun run index --cwd /path/to/your/project`. This builds the initial SQLite database and resolves symbols so that the MCP server is fully populated and starts immediately.
2. **Environment Variables:** If you plan on using AI docstring generation or semantic search (embedding-based), ensure your API keys (e.g. `CLAUDE_API_KEY`, `OPENAI_API_KEY`, etc.) are configured in the cloned server's `.env` file.
3. **File Watching:** When the MCP server starts, it initializes a file system watcher on the target project directory (using `chokidar`). It will automatically detect additions, modifications, and deletions, and update the SQLite symbol index incrementally in real-time.
