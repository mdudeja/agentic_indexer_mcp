import type { DocstringConfig } from 'src/config/types'
import { logWarning } from 'src/utils/logger'
import type { DocstringProvider } from './DocStringProvider'

/** A class providing integration with OpenAI's API for generating text-based responses from given prompts. It handles configuration settings like API keys and model selection, as well as error management during the generation process. */
export class OpenAIProvider implements DocstringProvider {
  /** Initializes a new instance of the OpenAI provider with configuration settings, including API key and optional model. */
  constructor(private cfg: NonNullable<DocstringConfig['openai']>) {}

  /** Generates text based on a given prompt by sending it to an AI service. Returns the generated response or null if an error occurs. */
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
