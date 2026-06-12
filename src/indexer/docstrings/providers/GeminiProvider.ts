import type { DocstringConfig } from 'src/config/types'
import type { DocstringProvider } from './DocStringProvider'
import { logWarning } from 'src/utils/logger'

/** A class that provides integration with Google's Gemini AI for generating text-based responses from given prompts. */
export class GeminiProvider implements DocstringProvider {
  /** Initializes a new instance of the Gemini provider using the specified configuration settings. */
  constructor(private cfg: NonNullable<DocstringConfig['gemini']>) {}

  /** Generates text based on a given prompt using Google's Gemini API. Returns the generated content as a string or null if generation fails. */
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
