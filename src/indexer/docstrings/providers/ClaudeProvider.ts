import type { DocstringConfig } from 'src/config/types'
import type { DocstringProvider } from './DocStringProvider'
import { logWarning } from 'src/utils/logger'

/** A class that provides integration with Claude AI for generating text from prompts as part of the DocstringProvider interface. */
export class ClaudeProvider implements DocstringProvider {
  /** Initializes a new instance of ClaudeProvider with the given configuration. */
  constructor(private cfg: NonNullable<DocstringConfig['claude']>) {}

  /** Generates text based on a given prompt using an AI model. Returns the generated text or null if generation fails. */
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
