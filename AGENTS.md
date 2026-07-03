# Agent Guidance: Agentic Indexer MCP

Welcome! This file provides critical context, design principles, architecture overviews, and instructions for AI agents working on or extending this repository.

---

## 🌟 Overview & Architecture

Agentic Indexer indexes codebases at a symbol level, making it easy for AI agents to locate definitions, find imports, construct call graphs, and understand type systems without blowing past context limits by loading raw source files. It registers **29 MCP tools** over `stdio` and runs incrementally by watching files using `chokidar`.

The codebase operates across the following directories:

```mermaid
graph TD
    CLI[index.ts] --> Config[src/config/]
    CLI --> DB[src/database/]
    CLI --> Server[src/server/]
    CLI --> Watcher[src/watcher/]
    Server --> Tools[src/server/tools/]
    Watcher --> Indexer[src/indexer/]
    Indexer --> Adapters[src/indexer/adapters/]
    Indexer --> Enhancers[src/indexer/enhancers/]
    Indexer --> DB
```

### Key Folders & Responsibilities

- [index.ts]: Main CLI entry point. Parses commands (`serve`, `index`, `enhance`, `query`, etc.).
- [src/config/]: Configuration loader, defaults, schema types.
- [src/database/]: SQLite database storage layer using Drizzle ORM and `sqlite-vec` for vector operations.
  - [IndexerDB.ts]: Singleton connection manager that initiates database connections, loads extensions, and applies migrations at startup.
- [src/indexer/]: Parser pipeline orchestration.
  - [adapters/]: Tree-sitter parsers for specific programming languages (e.g., `PythonAdapter`, `TypescriptAdapter`).
  - [enhancers/]: Type resolution, call site linkage, and structural analysis.
- [src/server/]: MCP Server instantiation and standard IO transport logic.
  - [tools/]: Declarations and handler logic for each registered MCP tool.
- [src/watcher/]: Incrementally re-indexes files on save/change.

---

## 🛠️ MCP Tool Registration

Each tool is declared in its own file in [src/server/tools/] and registered via [src/server/tools/index.ts].

### Adding a New Tool

1. Create a new tool file: `src/server/tools/my_new_tool.ts`.
2. Define the schema using `Type` or `zod` and call `server.tool()`:

   ```typescript
   import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
   import { Type } from '@sinclair/typebox'

   export function registerMyNewTool(server: McpServer) {
     server.tool(
       'my_new_tool',
       {
         param: Type.String({ description: 'A parameter description' }),
       },
       async ({ param }) => {
         // Tool logic here
         return {
           content: [{ type: 'text', text: `Result: ${param}` }],
         }
       },
     )
   }
   ```

3. Register it inside [src/server/tools/index.ts].

---

## 🔌 AST Adapters & Language Support

AST extraction is done using `web-tree-sitter`. To add support for a new language:

1. Create an adapter in [src/indexer/adapters/] inheriting from `LanguageAdapter`.
2. Map the AST node patterns matching classes, functions, calls, imports, and exports for that language.
3. Update [TreeSitterIndexer.ts] to detect files with the new language's extensions and instantiate your adapter.

---

## 💾 Database Schema & Migrations

We use **Drizzle ORM** with **SQLite**.

- The schemas are located in [src/database/schemas/].
- Migrations are saved under [drizzle_migrations/].
- `IndexerDB.init()` applies migrations automatically when starting.

If you modify database schemas:

1. Make your changes in the schema files.
2. Generate the migrations by running:
   ```bash
   bunx drizzle-kit generate
   ```

---

## 🧪 Testing

The tests are written using Bun's native test runner (`bun test`) and are located in the [tests/](file:///home/md/Projects/nvim_plugins/agentic_indexer_mcp/tests/) directory.

- Running tests:
  ```bash
  bun run test
  ```
- Running linter:
  ```bash
  bun run lint
  ```

> [!WARNING]
> Before submitting changes, always run the linter and tests to make sure there are no compiler errors or broken functionality.

---

## ⚠️ Important Rules for AI Agents

1. **Path Resolution:** Always use the `resolvePath` utility from [src/utils/paths.ts] when dealing with file/directory paths. This ensures compatibility when paths are relative to the target workspace or the indexer project home.
2. **Environment Variables:** Do not hardcode configurations. Read them from `process.env`. If a key is required, document it in `.env` and `.env.test`.
3. **Preserve Docstrings:** When editing files, maintain existing JSDoc/TSDoc headers and comments unless explicitly directed to change them.
4. **Clean Code & Modularity:** Keep MCP tool handlers slim. Keep business logic separated in repositories, adapters, or enhancers.
5. **Bun Project**: This is a Bun project. Do not use npm or yarn. Use bun instead.
6. **if not (condition) instead of nested if (condition)**: Use the early return principle unless absolutely necessary. So, instead of if (x) {something}, use if not (x) {return} then do something.
7. **Code Repetition**: Before writing any new feature or functionality, ensure that the same cannot be done by inbuilt methods of Bun or any other library used in the project, AND that you are not repeating any existing code. If you are, refactor and use the existing code.
8. **Test your code**: Always write test cases for the new feature or functionality you are adding.
