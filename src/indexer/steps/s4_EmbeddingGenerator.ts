import type { EmbedderConfig } from "src/config/types"
import { AppStateManager } from "src/state"

export abstract class EmbeddingGenerator {
    protected config?: EmbedderConfig

    constructor() {
        this.config = AppStateManager.getInstance().getItem('config')?.embedder
    }

    async init(): Promise<boolean> {
        throw new Error("init() not implemented")
    }

    async getEmbedding(_text: string): Promise<number[] | null> {
     throw new Error("getEmbedding() not implemented")   
    }
}