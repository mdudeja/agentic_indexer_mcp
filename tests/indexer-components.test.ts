import { describe, expect, test } from 'bun:test'
import {
  formatComment,
  getCommentText,
} from '../src/indexer/docstrings/formatComment'
import { createProvider } from '../src/indexer/docstrings/providers'
import { ClaudeProvider } from '../src/indexer/docstrings/providers/ClaudeProvider'
import { GeminiProvider } from '../src/indexer/docstrings/providers/GeminiProvider'
import { OpenAIProvider } from '../src/indexer/docstrings/providers/OpenAIProvider'
import { OllamaProvider } from '../src/indexer/docstrings/providers/OllamaProvider'
import { DocstringGenerationStep } from '../src/indexer/steps/s3_docstring_generator'
import { GenericLspEnhancer } from '../src/indexer/enhancers/GenericLspEnhancer'
import { PythonLspEnhancer } from '../src/indexer/enhancers/PythonLspEnhancer'
import { TypescriptLspEnhancer } from '../src/indexer/enhancers/TypescriptLspEnhancer'
import type { DocstringConfig } from 'src/config/types'

describe('Indexer Components Unit Tests', () => {
  test('should format comments correctly using formatComment and getCommentText', () => {
    const rawComment = '/**\n * This is a comment\n * @param x description\n */'
    const formatted = formatComment(rawComment, 'typescript')
    expect(formatted).toContain('* This is a comment')

    const cleanText = getCommentText(rawComment)
    expect(cleanText).toContain('This is a comment')
  })

  test('should instantiate docstring providers correctly via factory', () => {
    const claude = createProvider({
      enabled: true,
      provider: 'claude',
      write_to_file: false,
      claude: { api_key: 'dummy_key', model: 'dummy_model' },
      exclude_generation_patterns: [],
    })
    expect(claude).toBeInstanceOf(ClaudeProvider)

    const gemini = createProvider({
      enabled: true,
      provider: 'gemini',
      write_to_file: false,
      gemini: { api_key: 'dummy_key', model: 'dummy_model' },
      exclude_generation_patterns: [],
    })
    expect(gemini).toBeInstanceOf(GeminiProvider)

    const openai = createProvider({
      enabled: true,
      provider: 'openai',
      write_to_file: false,
      openai: { api_key: 'dummy_key', model: 'dummy_model' },
      exclude_generation_patterns: [],
    })
    expect(openai).toBeInstanceOf(OpenAIProvider)

    const ollama = createProvider({
      enabled: true,
      provider: 'ollama',
      write_to_file: false,
      ollama: { model: 'dummy_model', base_url: 'http://localhost:11434' },
      exclude_generation_patterns: [],
    })
    expect(ollama).toBeInstanceOf(OllamaProvider)
  })

  test('should instantiate DocstringGenerationStep and LSP enhancers safely', async () => {
    const step = new DocstringGenerationStep('/workspace')
    expect(step).toBeDefined()

    // Test LSP Enhancers handling empty commands gracefully
    const genericEnhancer = new GenericLspEnhancer(
      '/workspace',
      [],
      'typescript',
    )
    const initGeneric = await genericEnhancer.init()
    expect(initGeneric).toBe(false) // should fail to init with empty cmd

    const pythonEnhancer = new PythonLspEnhancer('/workspace', [], 'python')
    const initPython = await pythonEnhancer.init()
    expect(initPython).toBe(false)

    const tsEnhancer = new TypescriptLspEnhancer('/workspace', [], 'typescript')
    const initTs = await tsEnhancer.init()
    expect(initTs).toBe(false)
  })

  test('should format comments correctly for Python and other languages', () => {
    const pySingle = formatComment('single line', 'python')
    expect(pySingle).toBe('""" single line """')

    const pyMulti = formatComment('line one\nline two', 'python')
    expect(pyMulti).toBe('"""\nline one\nline two\n"""')

    const rubySingle = formatComment('single line', 'ruby')
    expect(rubySingle).toBe('# single line')

    const rubyMulti = formatComment('line one\nline two', 'ruby')
    expect(rubyMulti).toBe('# line one\n# line two')
  })

  test('should return null and log warnings when provider config is incomplete', () => {
    const claude = createProvider({
      enabled: true,
      provider: 'claude',
      write_to_file: false,
      claude: { api_key: '', model: 'dummy_model' },
    } as unknown as DocstringConfig)
    expect(claude).toBeNull()

    const gemini = createProvider({
      enabled: true,
      provider: 'gemini',
      write_to_file: false,
      gemini: { api_key: '', model: 'dummy_model' },
    } as unknown as DocstringConfig)
    expect(gemini).toBeNull()

    const openai = createProvider({
      enabled: true,
      provider: 'openai',
      write_to_file: false,
      openai: { api_key: '', model: 'dummy_model' },
    } as unknown as DocstringConfig)
    expect(openai).toBeNull()

    const ollama = createProvider({
      enabled: true,
      provider: 'ollama',
      write_to_file: false,
      ollama: { model: '', base_url: 'http://localhost:11434' },
    } as unknown as DocstringConfig)
    expect(ollama).toBeNull()
  })

  test('should generate docstrings from ClaudeProvider', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Claude docstring' }],
        }),
        { status: 200 },
      )
    }) as any
    const provider = new ClaudeProvider({ api_key: 'key', model: 'model' })
    const res = await provider.generate('prompt')
    expect(res).toBe('Claude docstring')

    globalThis.fetch = (async () => {
      return new Response('Claude API error message', { status: 400 })
    }) as any
    const resError = await provider.generate('prompt')
    expect(resError).toBeNull()

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'image', text: 'ignored' }],
        }),
        { status: 200 },
      )
    }) as any
    const resNoText = await provider.generate('prompt')
    expect(resNoText).toBeNull()

    globalThis.fetch = originalFetch
  })

  test('should generate docstrings from GeminiProvider', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Gemini docstring' }] } }],
        }),
        { status: 200 },
      )
    }) as any
    const provider = new GeminiProvider({ api_key: 'key', model: 'model' })
    const res = await provider.generate('prompt')
    expect(res).toBe('Gemini docstring')

    globalThis.fetch = (async () => {
      return new Response('Gemini API error', { status: 500 })
    }) as any
    const resError = await provider.generate('prompt')
    expect(resError).toBeNull()

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          candidates: [],
        }),
        { status: 200 },
      )
    }) as any
    const resNoParts = await provider.generate('prompt')
    expect(resNoParts).toBeNull()

    globalThis.fetch = originalFetch
  })

  test('should generate docstrings from OpenAIProvider', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          output: [{ content: [{ text: 'OpenAI docstring' }] }],
        }),
        { status: 200 },
      )
    }) as any
    const provider = new OpenAIProvider({ api_key: 'key', model: 'model' })
    const res = await provider.generate('prompt')
    expect(res).toBe('OpenAI docstring')

    globalThis.fetch = (async () => {
      return new Response('OpenAI API error', { status: 401 })
    }) as any
    const resError = await provider.generate('prompt')
    expect(resError).toBeNull()

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({}), { status: 200 })
    }) as any
    const resNoParts = await provider.generate('prompt')
    expect(resNoParts).toBeNull()

    globalThis.fetch = originalFetch
  })

  test('should generate docstrings from OllamaProvider', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ response: 'Ollama docstring' }), {
        status: 200,
      })
    }) as any
    const provider = new OllamaProvider('model', 'http://localhost')
    const res = await provider.generate('prompt')
    expect(res).toBe('Ollama docstring')

    globalThis.fetch = (async () => {
      return new Response('Ollama API error', { status: 500 })
    }) as any
    const resError = await provider.generate('prompt')
    expect(resError).toBeNull()

    globalThis.fetch = (async () => {
      throw new Error('connection refused')
    }) as any
    const resThrow = await provider.generate('prompt')
    expect(resThrow).toBeNull()

    globalThis.fetch = originalFetch
  })
})
