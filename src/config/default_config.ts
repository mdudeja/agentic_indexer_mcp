import { type IndexerConfig } from './types'

export const default_config: Record<'indexer', IndexerConfig> = {
  indexer: {
    enabled: true,
    ignore_patterns: [
      '.git',
      '.vscode',
      '.idea',
      '*.md',
      'drizzle_migrations',
      '*.lock',
      'tsconfig',
      '.prettier*',
      '.claude/*.json',
    ],
    extnToLangMap: {
      tsx: 'tsx',
      ts: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      json: 'json',
      py: 'python',
      lua: 'lua',
    },
    testFilePatterns: [
      /\.(test|spec)\.(ts|tsx|js|jsx)$/,
      /__tests__\//,
      /tests\//,
    ],
    entryPointPatterns: [/^index\.[a-z]+/, /^main\.[a-z]+/, /^app\.[a-z]+/],
    languages: {
      typescript: {
        extensions: ['.ts'],
        lsp_command: [
          '/home/md/.local/share/nvim/mason/bin/typescript-language-server',
          '--stdio',
        ],
        lang_features_paths: [
          'node_modules/typescript/lib',
          'node_modules/@types/node',
          'node_modules/%40types/node',
          'node_modules/@types/bun',
          'node_modules/%40types/bun',
        ],
        treesitter: {
          language_name: 'typescript',
          signature_max_length: 400,
        },
      },
      tsx: {
        extensions: ['.tsx'],
        lsp_command: [
          '/home/md/.local/share/nvim/mason/bin/typescript-language-server',
          '--stdio',
        ],
        lang_features_paths: [
          'node_modules/typescript/lib',
          'node_modules/@types/node',
          'node_modules/%40types/node',
          'node_modules/@types/bun',
          'node_modules/%40types/bun',
        ],
        treesitter: {
          language_name: 'tsx',
          signature_max_length: 400,
        },
      },
      python: {
        extensions: ['.py'],
        lsp_command: ['pyright-langserver', '--stdio'],
        treesitter: {
          language_name: 'python',
          signature_max_length: 400,
        },
      },
      lua: {
        extensions: ['.lua'],
        lsp_command: ['lua-language-server'],
        treesitter: {
          language_name: 'lua',
          signature_max_length: 400,
        },
      },
      javascript: {
        extensions: ['.js'],
        lsp_command: [
          '/home/md/.local/share/nvim/mason/bin/typescript-language-server',
          '--stdio',
        ],
        treesitter: {
          language_name: 'javascript',
          signature_max_length: 400,
        },
      },
    },
    docstring_generation: {
      enabled: true,
      provider: 'ollama',
      write_to_file: true,
      claude: {
        api_key: process.env.CLAUDE_API_KEY || '',
        model: 'claude-haiku-4-5',
      },
      gemini: {
        api_key: process.env.GEMINI_API_KEY || '',
        model: 'gemini-3-flash-preview',
      },
      openai: {
        api_key: process.env.OPENAI_API_KEY || '',
        model: 'gpt-4o-mini',
      },
      ollama: {
        base_url: 'http://localhost:11434',
        model: 'deepcoder',
      },
    },
    agent_config_candidates: [
      '.cursorrules',
      'CLAUDE.md',
      'AGENTS.md',
      'AGENT.md',
      'copilot-instructions.md',
      '.github/copilot-instructions.md',
      '.clinerules',
      '.windsurfrules',
    ],
    embedder: {
      enabled: true,
      provider: 'ollama',
      ollama: {
        base_url: 'http://localhost:11434',
        model: 'nomic-embed-text',
      },
    },
  },
}
