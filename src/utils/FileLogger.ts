import { dirname, join } from 'node:path'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import type { IndexerConfig } from 'src/config/types'
import { AppStateManager } from 'src/state'

const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024
const MAX_LOG_BACKUPS = 3

/** Handles logging messages to a file with rotation based on size and backup limits. */
export class FileLogger {
  private static instance: FileLogger | null = null
  private logFilePath: string
  private maxLogFileSizeBytes: number
  private maxLogBackups: number
  private writeQueue: Promise<void> = Promise.resolve()
  private config?: IndexerConfig

  private constructor(
    logFilePath = join(
      process.env.ACP_AGENTIC_DIR || '.agentic',
      'logs',
      'indexer_log.txt',
    ),
    maxLogFileSizeBytes = MAX_LOG_FILE_SIZE_BYTES,
    maxLogBackups = MAX_LOG_BACKUPS,
  ) {
    this.logFilePath = logFilePath
    this.maxLogFileSizeBytes = maxLogFileSizeBytes
    this.maxLogBackups = maxLogBackups

    this.config = AppStateManager.getInstance().getItem('config')
  }

  public static getInstance(): FileLogger {
    if (!this.instance) {
      this.instance = new FileLogger()
    }
    return this.instance
  }

  /**
   * Appends a message to a log in a file.
   * @param message The message to log.
   */
  public logMessage(message: string): Promise<void> {
    if (!this.config?.debugLogs) {
      return Promise.resolve()
    }

    const write = this.writeQueue.then(() => this.appendLogMessage(message))
    this.writeQueue = write.catch(() => {})
    return write
  }

  private async appendLogMessage(message: string): Promise<void> {
    await mkdir(dirname(this.logFilePath), { recursive: true })

    let currentSize = 0
    try {
      currentSize = (await stat(this.logFilePath)).size
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error
      }
    }

    const entry = `${message}\n`
    if (
      currentSize > 0 &&
      currentSize + Buffer.byteLength(entry) > this.maxLogFileSizeBytes
    ) {
      await this.rotateLogFile()
    }

    await appendFile(this.logFilePath, entry, 'utf8')
  }

  private async rotateLogFile(): Promise<void> {
    if (this.maxLogBackups === 0) {
      await rm(this.logFilePath, { force: true })
      return
    }

    await rm(`${this.logFilePath}.${this.maxLogBackups}`, { force: true })
    for (let index = this.maxLogBackups - 1; index >= 1; index--) {
      await this.renameIfPresent(
        `${this.logFilePath}.${index}`,
        `${this.logFilePath}.${index + 1}`,
      )
    }
    await this.renameIfPresent(this.logFilePath, `${this.logFilePath}.1`)
  }

  private async renameIfPresent(
    source: string,
    destination: string,
  ): Promise<void> {
    try {
      await rename(source, destination)
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error
      }
    }
  }
}
