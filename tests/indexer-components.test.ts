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
    })
    expect(claude).toBeInstanceOf(ClaudeProvider)

    const gemini = createProvider({
      enabled: true,
      provider: 'gemini',
      write_to_file: false,
      gemini: { api_key: 'dummy_key', model: 'dummy_model' },
    })
    expect(gemini).toBeInstanceOf(GeminiProvider)

    const openai = createProvider({
      enabled: true,
      provider: 'openai',
      write_to_file: false,
      openai: { api_key: 'dummy_key', model: 'dummy_model' },
    })
    expect(openai).toBeInstanceOf(OpenAIProvider)

    const ollama = createProvider({
      enabled: true,
      provider: 'ollama',
      write_to_file: false,
      ollama: { model: 'dummy_model', base_url: 'http://localhost:11434' },
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
})
