import { type EmbeddingGenerator } from '../steps/s4_EmbeddingGenerator'
import type { EmbedderConfig } from 'src/config/types'
import { AppStateManager } from 'src/state'
import { logError } from 'src/utils/logger'

/** Generates text embeddings using the Ollama API to convert text into numerical vector representations for machine learning tasks. */
export class OllamaEmbeddingGenerator implements EmbeddingGenerator {
  private config?: EmbedderConfig
  private ollamaConfig: EmbedderConfig['ollama']
  /** The constructor initializes an instance of the OllamaEmbeddingGenerator by loading its configuration settings. */
  constructor() {
    this.config = AppStateManager.getInstance().getItem('config')?.embedder
    this.ollamaConfig = this.config?.ollama
  }

  /** Initialize the embedding generator and verify its functionality through a connection test. Returns true if successful, false otherwise. */
  async init(): Promise<boolean> {
    const testEmbed = await this.getEmbedding('test connection')

    if (!testEmbed) {
      logError('[Indexer] Failed to initialize embeddor.')
      return false
    }

    return true
  }

  /** Generates embeddings from text using the Ollama API. Converts input text into numerical vector representations for machine learning tasks. */
  async getEmbedding(text: string): Promise<number[] | null> {
    if (!this.config || !this.config.enabled || !this.ollamaConfig) {
      return null
    }
    const baseUrl = this.ollamaConfig.base_url || 'http://localhost:11434'
    const model = this.ollamaConfig.model || 'nomic-embed-text'

    try {
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model,
          prompt: text,
        }),
      })
      if (!response.ok) {
        throw new Error(
          `Ollama API returned status ${response.status}: ${response.statusText}`,
        )
      }
      const data = (await response.json()) as { embedding: number[] }
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid response format from Ollama embeddings API')
      }
      return data.embedding
    } catch (e) {
      logError(
        `[Embeddings] Failed to generate embedding with model "${this.config.ollama?.model}" at ${this.config.ollama?.base_url}:`,
        e,
      )
      return null
    }
  }
}
