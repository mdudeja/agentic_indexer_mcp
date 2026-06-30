import { logWarning } from 'src/utils/logger'
import type { DocstringProvider } from './DocStringProvider'

/** A class that interfaces with the Ollama API to generate responses based on provided prompts. */
export class OllamaProvider implements DocstringProvider {
  /** Initializes the OllamaProvider with a specified model and optional base URL for connecting to the Ollama API. */
  constructor(
    private model: string,
    private baseUrl: string = 'http://localhost:11434',
  ) {}

  /** Generates a response to the given prompt by interacting with an AI model through an API. Returns the generated text or null if no valid response is received. */
  async generate(prompt: string): Promise<string | null> {
    try {
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
    } catch (error) {
      logWarning(`[DocstringProvider] ollama API error: ${error}`)
      return null
    }
  }
}
