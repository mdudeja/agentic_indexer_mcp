import { watch, type FSWatcher } from 'chokidar'
import { IndexPipeline } from '../indexer/IndexPipeline'
import { IndexerDB } from '../database/IndexerDB'
import { relative } from 'path'
import { logInfo, logError } from 'src/utils/logger'

/** A class that monitors a specified directory for file system changes. It tracks additions, modifications, and deletions of files within the directory, triggering corresponding actions such as reindexing or cleaning up associated data. */
export class Watcher {
  private watcher: FSWatcher | null = null

  /** Initializes a new instance of the Watcher with the specified current working directory. */
  constructor(private cwd: string) {}

  /** Starts monitoring a directory for file changes, triggering corresponding actions for added, modified, or removed files. */
  start() {
    logInfo(`[watcher] Starting file watcher for ${this.cwd}`)

    this.watcher = watch(this.cwd, {
      ignored: /(^|[\/\\])(\..+|node_modules|dist|build)/,
      persistent: true,
      ignoreInitial: true,
    })

    const db = IndexerDB.getInstance()
    const pipeline = new IndexPipeline({
      cwd: this.cwd,
      store: db,
      includeGitIgnored: false,
    })

    this.watcher
      .on('add', async (path) => {
        await pipeline.runOnFile(path)
      })
      .on('change', async (path) => {
        await pipeline.runOnFile(path)
      })
      .on('unlink', async (path) => {
        const relPath = relative(this.cwd, path)
        await db.deleteFile(relPath)
        logInfo(`[watcher] Unlinked file: ${relPath}`)
      })
      .on('error', (error) => logError(`[watcher] Error: ${error}`))
  }

  /** Stop the watching process. */
  stop() {
    if (this.watcher) {
      this.watcher.close()
    }
  }
}
