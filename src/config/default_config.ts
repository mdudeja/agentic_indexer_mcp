import { DocstringStrategy, SymbolKind, type IndexerConfig } from './types'

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
    },
    languages: {
      typescript: {
        extensions: ['.ts'],
        treesitter: {
          language_name: 'typescript',
          block_init_marker: '{',
          nodes_info: {
            import_statement: {
              kind: SymbolKind.import,
              name_field: 'name',
              source_field: 'source',
            },
            export_statement: {
              kind: SymbolKind.export,
              name_field: 'name',
              source_field: 'source',
              docstring: DocstringStrategy.comment_before,
            },
            export_default_declaration: {
              kind: SymbolKind.export,
              name_field: 'name',
              source_field: 'source',
              docstring: DocstringStrategy.comment_before,
            },
            function_declaration: {
              kind: SymbolKind.function,
              name_field: 'name',
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
            },
            method_definition: {
              kind: SymbolKind.method,
              name_field: 'name',
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
            },
            class_declaration: {
              kind: SymbolKind.class,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            public_field_definition: {
              kind: SymbolKind.property,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            variable_declaration: {
              kind: SymbolKind.var,
              name_field: 'name',
            },
            lexical_declaration: {
              kind: SymbolKind.let,
              name_field: 'name',
            },
            interface_declaration: {
              kind: SymbolKind.interface,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            type_alias_declaration: {
              kind: SymbolKind.type,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            enum_declaration: {
              kind: SymbolKind.enum,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            decorator: {
              kind: SymbolKind.decorator,
            },
            internal_module: {
              kind: SymbolKind.namespace,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            module: {
              kind: SymbolKind.module,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            arrow_function: {
              kind: SymbolKind.arrowFunction,
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
              inherit_name_from_parent: true,
            },
          },
          lists: {
            exported_nodes: ['export_statement', 'export_default_declaration'],
            callable_nodes: [
              'function_declaration',
              'method_definition',
              'arrow_function',
            ],
            callable_kinds: [
              SymbolKind.function,
              SymbolKind.method,
              SymbolKind.arrowFunction,
            ],
            container_nodes: ['class_declaration', 'module', 'internal_module'],
            typedef_nodes: [
              'type_alias_declaration',
              'interface_declaration',
              'enum_declaration',
            ],
            decorator_nodes: ['decorator'],
            additional_nodes: [
              'public_field_definition',
              'variable_declaration',
              'lexical_declaration',
            ],
          },
        },
      },
      tsx: {
        extensions: ['.tsx'],
        treesitter: {
          language_name: 'tsx',
          block_init_marker: '{',
          nodes_info: {
            import_statement: {
              kind: SymbolKind.import,
              name_field: 'name',
              source_field: 'source',
            },
            function_declaration: {
              kind: SymbolKind.function,
              name_field: 'name',
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
            },
            method_definition: {
              kind: SymbolKind.method,
              name_field: 'name',
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
            },
            class_declaration: {
              kind: SymbolKind.class,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            public_field_definition: {
              kind: SymbolKind.property,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            variable_declaration: {
              kind: SymbolKind.var,
              name_field: 'name',
            },
            lexical_declaration: {
              kind: SymbolKind.let,
              name_field: 'name',
            },
            interface_declaration: {
              kind: SymbolKind.interface,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            type_alias_declaration: {
              kind: SymbolKind.type,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            enum_declaration: {
              kind: SymbolKind.enum,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            decorator: {
              kind: SymbolKind.decorator,
            },
            internal_module: {
              kind: SymbolKind.namespace,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            module: {
              kind: SymbolKind.module,
              name_field: 'name',
              docstring: DocstringStrategy.comment_before,
            },
            arrow_function: {
              kind: SymbolKind.arrowFunction,
              parameters_field: 'parameters',
              return_type_field: 'return_type',
              docstring: DocstringStrategy.comment_before,
              inherit_name_from_parent: true,
            },
          },
          lists: {
            exported_nodes: ['export_statement', 'export_default_declaration'],
            callable_nodes: [
              'function_declaration',
              'method_definition',
              'arrow_function',
            ],
            callable_kinds: [
              SymbolKind.function,
              SymbolKind.method,
              SymbolKind.arrowFunction,
            ],
            container_nodes: ['class_declaration', 'module', 'internal_module'],
            typedef_nodes: [
              'type_alias_declaration',
              'interface_declaration',
              'enum_declaration',
            ],
            decorator_nodes: ['decorator'],
            additional_nodes: [
              'public_field_definition',
              'variable_declaration',
              'lexical_declaration',
            ],
          },
        },
      },
      //   python: { extensions: ['.py'] },
      //   lua: { extensions: ['.lua'] },
      //   go: { extensions: ['.go'] },
    },
    docstring_generation: {
      enabled: true,
      provider: 'ollama',
      write_to_file: true,
      claude: {
        api_key: Bun.env.CLAUDE_API_KEY || '',
        model: 'claude-haiku-4-5',
      },
      gemini: {
        api_key: Bun.env.GEMINI_API_KEY || '',
        model: 'gemini-3-flash-preview',
      },
      openai: {
        api_key: Bun.env.OPENAI_API_KEY || '',
        model: 'gpt-4o-mini',
      },
      ollama: {
        base_url: 'http://localhost:11434',
        model: 'llama3.2',
      },
    },
  },
}
