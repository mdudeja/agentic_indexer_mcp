import { randomUUIDv7 } from 'bun'
import { IndexerDB } from 'src/database/IndexerDB'

/** Updates the usage statistics for a given tool. */
export async function updateUsage(
  toolName: string,
  filesPaths: string[],
  responseLength: number,
  skipFileTokenCount: boolean = false,
): Promise<void> {
  const store = IndexerDB.getInstance()
  const sourceTokens = skipFileTokenCount
    ? filesPaths.reduce((acc, path) => acc + path.length, 0)
    : await store.getEstimatedTokensForFiles(filesPaths)
  const responseTokens = Math.ceil(responseLength / 4)

  await store.recordToolUsage({
    id: randomUUIDv7(),
    tool_name: toolName,
    source_tokens: sourceTokens,
    response_tokens: responseTokens,
    tokens_saved: Math.max(0, sourceTokens - responseTokens),
  })
}
