import { watch, type FSWatcher } from 'chokidar'
import { IndexPipeline } from '../indexer/IndexPipeline'
import { IndexerDB } from '../database/IndexerDB'
import { relative } from 'path'
import { logInfo, logError } from 'src/utils/logger'
import { FileManager } from 'src/indexer/FileManager'
import { AppStateManager } from 'src/state'

/** How long to wait after the most recent file event before processing a batch. Resets on every new event so a burst of changes (e.g. a branch switch) collapses into one run. */
const DEBOUNCE_MS = 500

type PendingKind = 'upsert' | 'unlink'

/** A class that monitors a specified directory for file system changes. It tracks additions, modifications, and deletions of files within the directory, triggering corresponding actions such as reindexing or cleaning up associated data. Events are debounced and coalesced into batches so bursts of changes (e.g. a branch switch) don't fire many overlapping pipeline runs. */
export class Watcher {
  private watcher: FSWatcher | null = null
  private fileManager: FileManager | null = null
  private pipeline: IndexPipeline | null = null
  private db: IndexerDB | null = null

  private pending = new Map<string, PendingKind>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private isProcessing = false

  /** Initializes a new instance of the Watcher with the specified current working directory. */
  constructor(private cwd: string) {
    this.fileManager =
      AppStateManager.getInstance().getItem('fileManager') ?? null
  }

  /** Starts monitoring a directory for file changes, triggering corresponding actions for added, modified, or removed files. */
  async start() {
    logInfo(`[watcher] Starting file watcher for ${this.cwd}`)

    if (!this.fileManager) {
      this.fileManager = await FileManager.getInstance()
      AppStateManager.getInstance().setItem('fileManager', this.fileManager)
    }

    this.watcher = watch(this.cwd, {
      ignored: (path) => this.fileManager!.isPathIgnored(path),
      persistent: true,
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: true,
      cwd: this.cwd,
    })

    this.db = IndexerDB.getInstance()
    this.pipeline = new IndexPipeline({
      cwd: this.cwd,
      store: this.db,
    })

    this.watcher
      .on('add', (path) => this.enqueue(path, 'upsert'))
      .on('change', (path) => this.enqueue(path, 'upsert'))
      .on('unlink', (path) => this.enqueue(path, 'unlink'))
      .on('error', (error) => logError(`[watcher] Error: ${error}`))
  }

  /** Queues a file event and (re)schedules the debounce timer. Later events for the same path within the debounce window replace earlier ones, so a delete-then-recreate only ever runs the last observed state. */
  private enqueue(path: string, kind: PendingKind) {
    this.pending.set(path, kind)

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.flush()
    }, DEBOUNCE_MS)
  }

  /** Drains the pending queue and runs the pipeline over the whole batch. Guarded so only one batch is ever in flight at a time; events that arrive mid-flush are picked up by another flush once the current one finishes. */
  private async flush() {
    if (this.isProcessing || this.pending.size === 0) return

    this.isProcessing = true
    const batch = new Map(this.pending)
    this.pending.clear()

    try {
      await this.processBatch(batch)
    } catch (error) {
      logError(`[watcher] Failed to process batch:`, error)
    } finally {
      this.isProcessing = false
      if (this.pending.size > 0) {
        void this.flush()
      }
    }
  }

  /** Applies a coalesced batch of file events: deletes unlinked files, then runs symbol extraction, enhancement, and docstring generation once across every changed file instead of once per file. */
  private async processBatch(batch: Map<string, PendingKind>) {
    if (!this.pipeline || !this.db) {
      throw new Error(
        'Watcher not initialized. Call start() before processing batches.',
      )
    }

    const upsertPaths: string[] = []
    for (const [path, kind] of batch) {
      if (kind === 'unlink') {
        const relPath = relative(this.cwd, path)
        await this.db.files.delete(relPath)
        logInfo(`[watcher] Unlinked file: ${relPath}`)
      } else {
        upsertPaths.push(path)
      }
    }

    if (upsertPaths.length === 0) return

    logInfo(
      `[watcher] Processing batch of ${upsertPaths.length} changed file(s)`,
    )

    const processedRelPaths: string[] = []
    for (const path of upsertPaths) {
      const relPath = await this.pipeline.runOnFile(path)
      if (relPath) processedRelPaths.push(relPath)
    }

    if (processedRelPaths.length === 0) return

    await Bun.sleep(100) // slight delay to ensure files are fully written before enhancement/docstring steps
    await this.pipeline.runEnhancementStep(processedRelPaths)
    for (const relPath of processedRelPaths) {
      await this.pipeline.runDocstringStep(relPath)
    }

    await this.pipeline.runEmbeddingStep(processedRelPaths)
  }

  /** Stops the watching process. Drops any not-yet-processed debounced events and waits for a currently in-flight batch to finish, so callers can safely close the database connection right after this resolves. */
  async stop() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pending.clear()

    if (this.watcher) {
      await this.watcher.close()
    }

    while (this.isProcessing) {
      await Bun.sleep(50)
    }
  }
}
