export interface EmbeddingGenerator {
  init(): Promise<boolean>
  getEmbedding(text: string): Promise<number[] | null>
}
