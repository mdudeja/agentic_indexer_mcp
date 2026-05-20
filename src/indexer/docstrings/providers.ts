import type { DocstringConfig } from 'src/config/types'

export interface DocstringProvider {
  generate(prompt: string): Promise<string | null>
}

class ClaudeProvider implements DocstringProvider {
  async generate(prompt: string): Promise<string | null> {
    const proc = Bun.spawn(['claude', '-p', prompt], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? text.trim() : null
  }
}

class GeminiProvider implements DocstringProvider {
  async generate(prompt: string): Promise<string | null> {
    const proc = Bun.spawn(['gemini', '-p', prompt], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? text.trim() : null
  }
}

class CodexProvider implements DocstringProvider {
  async generate(prompt: string): Promise<string | null> {
    const proc = Bun.spawn(['codex', '-p', prompt], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return proc.exitCode === 0 ? text.trim() : null
  }
}

class OllamaProvider implements DocstringProvider {
  constructor(
    private model: string,
    private baseUrl: string = 'http://localhost:11434',
  ) {}

  async generate(prompt: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { response?: string }
    return data.response?.trim() ?? null
  }
}

export function createProvider(config: DocstringConfig): DocstringProvider {
  switch (config.provider) {
    case 'claude':
      return new ClaudeProvider()
    case 'gemini':
      return new GeminiProvider()
    case 'codex':
      return new CodexProvider()
    case 'ollama':
      return new OllamaProvider(config.ollama!.model, config.ollama?.base_url)
  }
}
