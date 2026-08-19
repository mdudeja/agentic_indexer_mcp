import { AppStateManager } from 'src/state'
import { embedderNameToClass } from 'src/indexer/IndexPipeline'
import type { EmbeddingGenerator } from 'src/indexer/steps/s4_EmbeddingGenerator'
import { logError } from 'src/utils/logger'

/**
 * Attempts to load and initialize an embedding generator based on configuration
 * settings. Returns null if configuration is missing or initialization fails.
 */
export async function loadEmbedder(): Promise<EmbeddingGenerator | null> {
  const config = AppStateManager.getInstance().getItem('config')
  if (
    !config ||
    !config.embedder ||
    !config.embedder.enabled ||
    !config.embedder.provider
  ) {
    logError(
      '[Indexer] No embedder configuration found or embedder is not enabled. Skipping embedding generation.',
    )
    return null
  }
  const EmbedderClass = embedderNameToClass[config.embedder.provider]
  if (!EmbedderClass) {
    logError('[Indexer] Embedder not found. Skipping embedding generation.')
    return null
  }

  const embedder = new EmbedderClass()
  const initialized = await embedder.init()
  if (!initialized) {
    logError(
      `[Indexer] Failed to initialize ${embedder.constructor.name}. Skipping embedding generation.`,
    )
    return null
  }

  return embedder
}
