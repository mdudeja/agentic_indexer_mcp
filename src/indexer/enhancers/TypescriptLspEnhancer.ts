import { logError } from 'src/utils/logger'
import { TypescriptCallEdgeResolver } from '../resolvers/callEdgeResolvers'
import { GenericLspEnhancer } from './GenericLspEnhancer'

/** Specialized LSP enhancer for TypeScript, extending generic LSP capabilities with language-specific optimizations and features. */
export class TypescriptLspEnhancer extends GenericLspEnhancer {
  /** Initialize the object or system and return a Promise indicating success. */
  override async init(): Promise<boolean> {
    const superReturn = await super.init()
    if (!superReturn) {
      return false
    }

    try {
      this.callEdgeResolver = new TypescriptCallEdgeResolver(
        this.client!,
        this.languageId,
      )
      return superReturn
    } catch (err) {
      logError(
        `Failed to initialize TypescriptCallEdgeResolver: ${err}`,
        'TypescriptLspEnhancer',
      )
      return false
    }
  }
}
