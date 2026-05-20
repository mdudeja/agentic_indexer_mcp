import type { DocstringConfig } from 'src/config/types'
import { logWarning } from 'src/utils/logger'

export interface DocstringProvider {
  generate(prompt: string): Promise<string | null>
}

/** Implementation of DocstringProvider that generates text responses using the Anthropic Claude API. */
class ClaudeProvider implements DocstringProvider {
  /** Initializes the Claude provider with the specified configuration. */
  constructor(private cfg: NonNullable<DocstringConfig['claude']>) {}

  /** Asynchronously generates a text response for the given prompt using the Anthropic API, returning the resulting text or null if the request fails. */
  async generate(prompt: string): Promise<string | null> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.cfg.api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.cfg.model ?? 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      logWarning(
        `[DocstringProvider] claude API error: ${res.status} ${await res.text()}`,
      )
      return null
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text: string }>
    }
    return data.content.find((b) => b.type === 'text')?.text?.trim() ?? null
  }
}

/** An implementation of the DocstringProvider interface that generates content using the Google Gemini API. */
class GeminiProvider implements DocstringProvider {
  /** Initializes a new instance of the GeminiProvider with the specified configuration. */
  constructor(private cfg: NonNullable<DocstringConfig['gemini']>) {}

  /** Generates text content from the Gemini API using the provided prompt and returns the result or null on error. */
  async generate(prompt: string): Promise<string | null> {
    const model = this.cfg.model ?? 'gemini-3-flash-preview'
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.cfg.api_key,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      },
    )
    if (!res.ok) {
      logWarning(
        `[DocstringProvider] gemini API error: ${res.status} ${await res.text()}`,
      )
      return null
    }
    const data = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>
    }
    return data.candidates[0]?.content.parts[0]?.text?.trim() ?? null
  }
}

/** Implementation of the DocstringProvider interface that generates text using the OpenAI API based on a provided configuration. */
class OpenAIProvider implements DocstringProvider {
  /** Initializes a new instance of the OpenAIProvider with the specified configuration. */
  constructor(private cfg: NonNullable<DocstringConfig['openai']>) {}

  /** Generates text by sending a prompt to the OpenAI API and returns the trimmed response content or null if the request fails or is malformed. */
  async generate(prompt: string): Promise<string | null> {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.cfg.model ?? 'gpt-4o-mini',
        input: prompt,
      }),
    })
    if (!res.ok) {
      logWarning(
        `[DocstringProvider] OpenAI API error: ${res.status} ${await res.text()}`,
      )
      return null
    }
    const data = (await res.json()) as {
      output: Array<{ content: Array<{ text: string }> }>
    }
    return data.output?.[0]?.content?.[0]?.text?.trim() ?? null
  }
}

/** Provides docstring generation services via the Ollama API using a specified model and base URL. */
class OllamaProvider implements DocstringProvider {
  /** Initializes a new instance of the OllamaProvider class with a specific model and an optional base URL. */
  constructor(
    private model: string,
    private baseUrl: string = 'http://localhost:11434',
  ) {}

  /** Generates a response for the given prompt by calling the API and returns the trimmed result or null if the request fails. */
  async generate(prompt: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
    })
    if (!res.ok) {
      logWarning(`[DocstringProvider] ollama API error: ${res.status}`)
      return null
    }
    const data = (await res.json()) as { response?: string }
    return data.response?.trim() ?? null
  }
}

/** Instantiates a docstring provider based on the provided configuration or returns null if required settings are missing. */
export function createProvider(
  config: DocstringConfig,
): DocstringProvider | null {
  switch (config.provider) {
    case 'claude':
      if (!config.claude?.api_key) {
        logWarning(
          '[DocstringProvider] claude selected but no claude.api_key in config',
        )
        return null
      }
      return new ClaudeProvider(config.claude)
    case 'gemini':
      if (!config.gemini?.api_key) {
        logWarning(
          '[DocstringProvider] gemini selected but no gemini.api_key in config',
        )
        return null
      }
      return new GeminiProvider(config.gemini)
    case 'openai':
      if (!config.openai?.api_key) {
        logWarning(
          '[DocstringProvider] openai selected but no openai.api_key in config',
        )
        return null
      }
      return new OpenAIProvider(config.openai)
    case 'ollama':
      if (!config.ollama?.model) {
        logWarning(
          '[DocstringProvider] ollama selected but no ollama.model in config',
        )
        return null
      }
      return new OllamaProvider(config.ollama.model, config.ollama.base_url)
  }
}
