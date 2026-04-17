# Agentic Indexer MCP

A powerful Model Context Protocol (MCP) server that provides structured, symbol-level code retrieval for AI agents. Built with Bun, Tree-sitter, and SQLite, it allows AI models to efficiently explore, search, and parse codebases without wasting context window tokens by reading entire files.

*Inspired by projects like [jCodeMunch MCP](https://github.com/jgravelle/jcodemunch-mcp).*

![Bun](https://img.shields.io/badge/Bun-1.0+-black?logo=bun)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)
![SQLite](https://img.shields.io/badge/SQLite-blue?logo=sqlite)
![Tree-sitter](https://img.shields.io/badge/Tree--sitter-green)
![MCP](https://img.shields.io/badge/MCP-compatible-purple)

---

## What the Project Does

Agentic Indexer indexes your local codebase using native AST parsing (via [web-tree-sitter](https://github.com/tree-sitter/tree-sitter)). It extracts symbols—such as functions, classes, methods, and variables—and stores their structured metadata (signatures, docstrings, and byte offsets) into a local SQLite database along with file hashes. 

When an AI agent (like Claude or a local LLM via Cursor etc.) needs context, it can use this MCP server to:
- **Search for symbols globally.**
- **Fetch specific details (signature, exact file line constraints).**
- **Read file outlines.**
- **Avoid loading unnecessary thousands of lines into the context.**

Doing so massively reduces token waste and improves your model's reasoning capabilities by feeding it exact components rather than a dumped codebase string.

---

## Architecture

1. **Parser Layer (Tree-Sitter):** 
   - Uses `web-tree-sitter` and compiled `.wasm` grammars to parse source files precisely.
   - Converts the AST nodes into domain-specific symbols and metadata (currently heavily optimized for TS/JS files).
2. **Database Layer (Drizzle + Bun SQLite):**
   - Employs a local SQLite instance to persist file path tracking, state timestamps, and Symbol entities.
   - `Drizzle ORM` is used for strongly typed schema configurations and migrations.
   - Hashes file contents before re-parsing to optimize subsequent runs.
3. **MCP Server Exporter:**
   - Registers standard `MCP` protocol tools (`@modelcontextprotocol/sdk`) over `stdio`. 
   - `search_symbols`: Searches by wildcard, name, and kind.
   - `get_definition`: Returns exact details for a specific symbol ID or name.
   - `list_files`: Outlines indexed files within your codebase directory.
   - `get_file_summary`: Provides an overview of the symbols belonging to a specific file.

---

## How to Use It

### Prerequisites
- [Bun](https://bun.sh/) (latest version)

### Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/your-username/agentic_indexer_mcp.git
cd agentic_indexer_mcp
bun install
```

### CLI Commands

The core commands leverage `index.ts` to manage your environment:

1. **Index a workspace (One-off Build):**
   Run the initial parser pass on your codebase.
   ```bash
   bun run index --cwd /path/to/your/project
   ```

2. **Query the Index locally:**
   Search for symbols via the CLI without starting the server, useful for testing that data was successfully parsed.
   ```bash
   bun run query --cwd /path/to/your/project -q "auth*" -k "function"
   ```

3. **Start the MCP Server:**
   This reads commands via `stdio`, acting as the backend engine for agents adhering to the MCP spec.
   *(Configure your MCP consumer—like Cursor, Claude Desktop, or your custom agent—to execute this start command as a plugin/server payload.)*
   ```bash
   bun run start --cwd /path/to/your/project
   ```

---

## Features Still to be Developed

Agentic Indexer is under active development. Below are planned features to make it a globally aware architectural reasoning tool for AI:

- **Broader Language Support**: Expanding from `ts/js/tsx/jsx` into Go, Python, Rust, and others using dynamic WASM or native binding `tree-sitter` fallback loading strategies.
- **Deep Impact Analysis (Blast Radius & Importers)**: Computing and traversing the abstract import graphs to inform agents exactly what files/functions depend on a target symbol.
- **Symbol Coarser Context & Snippet Stitching**: Returning contiguous grouped snippets instead of line-separated data if symbols are logically combined.
- **Refactoring Planner Support**: Feeding context to the server so it returns structural edits instead of relying purely on the LLM's inline capabilities.
- **Live Watch & Real-time Re-indexing**: Running a daemon watch strategy alongside `serve` to instantly reconcile database state when a file modify event is emitted on the disk.
- **Testing Metric & Call Hierarchies**: Determining dead code, untested functions, or generating multi-depth call stacks automatically.
