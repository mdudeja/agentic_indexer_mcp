import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IndexerConfig } from '../src/config/types'
import { AppStateManager } from '../src/state'
import { FileLogger } from '../src/utils/FileLogger'

type LoggerModule = typeof import('../src/utils/logger')

/** Re-imports logger so the module-level IDXR_LOG_LEVEL is re-read. */
async function loadLogger(level: string): Promise<LoggerModule> {
  const original = process.env.IDXR_LOG_LEVEL
  process.env.IDXR_LOG_LEVEL = level
  try {
    return (await import(
      `../src/utils/logger.ts?level=${level}`
    )) as LoggerModule
  } finally {
    if (original === undefined) delete process.env.IDXR_LOG_LEVEL
    else process.env.IDXR_LOG_LEVEL = original
  }
}

type FileLoggerInternals = {
  instance: FileLogger | null
  new (path: string, maxSize?: number, maxBackups?: number): FileLogger
}
const Internals = FileLogger as unknown as FileLoggerInternals

/** Waits for all queued writes of the logger to finish. */
async function flush(logger: FileLogger) {
  await (logger as unknown as { writeQueue: Promise<void> }).writeQueue
}

let tmpDir: string
let logPath: string
let originalConfig: IndexerConfig | undefined
let originalAgenticDir: string | undefined

function setDebugLogs(enabled: boolean | undefined) {
  AppStateManager.getInstance().setItem('config', {
    debugLogs: enabled,
  } as unknown as IndexerConfig)
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'file-logger-test-'))
  logPath = join(tmpDir, 'logs', 'indexer_log.txt')
  originalConfig = AppStateManager.getInstance().getItem('config')
  originalAgenticDir = process.env.ACP_AGENTIC_DIR
  Internals.instance = null
})

afterEach(async () => {
  Internals.instance = null
  if (originalAgenticDir === undefined) delete process.env.ACP_AGENTIC_DIR
  else process.env.ACP_AGENTIC_DIR = originalAgenticDir
  AppStateManager.getInstance().setItem('config', originalConfig)
  await rm(tmpDir, { recursive: true, force: true })
})

describe('FileLogger', () => {
  it('getInstance returns a singleton', () => {
    setDebugLogs(false)
    expect(FileLogger.getInstance()).toBe(FileLogger.getInstance())
  })

  it('does not write when debugLogs is disabled', async () => {
    setDebugLogs(false)
    const logger = new Internals(logPath)
    await logger.logMessage('hello')
    expect(existsSync(logPath)).toBe(false)
  })

  it('does not write when config is missing', async () => {
    AppStateManager.getInstance().deleteItem('config')
    const logger = new Internals(logPath)
    await logger.logMessage('hello')
    expect(existsSync(logPath)).toBe(false)
  })

  it('creates the directory and appends messages in order', async () => {
    setDebugLogs(true)
    const logger = new Internals(logPath)
    await Promise.all([
      logger.logMessage('one'),
      logger.logMessage('two'),
      logger.logMessage('three'),
    ])
    expect(await readFile(logPath, 'utf8')).toBe('one\ntwo\nthree\n')
  })

  it('uses ACP_AGENTIC_DIR for the default log path', async () => {
    setDebugLogs(true)
    process.env.ACP_AGENTIC_DIR = tmpDir
    await FileLogger.getInstance().logMessage('default path')
    expect(
      await readFile(join(tmpDir, 'logs', 'indexer_log.txt'), 'utf8'),
    ).toBe('default path\n')
  })

  it('rotates the file when the size limit is exceeded', async () => {
    setDebugLogs(true)
    const logger = new Internals(logPath, 10, 2)
    await logger.logMessage('aaaaaaa') // 8 bytes
    await logger.logMessage('bbbbbbb')
    await logger.logMessage('ccccccc')

    expect(await readFile(logPath, 'utf8')).toBe('ccccccc\n')
    expect(await readFile(`${logPath}.1`, 'utf8')).toBe('bbbbbbb\n')
    expect(await readFile(`${logPath}.2`, 'utf8')).toBe('aaaaaaa\n')
  })

  it('discards the oldest backup beyond maxLogBackups', async () => {
    setDebugLogs(true)
    const logger = new Internals(logPath, 10, 1)
    await logger.logMessage('aaaaaaa')
    await logger.logMessage('bbbbbbb')
    await logger.logMessage('ccccccc')

    expect(await readFile(logPath, 'utf8')).toBe('ccccccc\n')
    expect(await readFile(`${logPath}.1`, 'utf8')).toBe('bbbbbbb\n')
    expect(existsSync(`${logPath}.2`)).toBe(false)
  })

  it('truncates without backups when maxLogBackups is 0', async () => {
    setDebugLogs(true)
    const logger = new Internals(logPath, 10, 0)
    await logger.logMessage('aaaaaaa')
    await logger.logMessage('bbbbbbb')

    expect(await readFile(logPath, 'utf8')).toBe('bbbbbbb\n')
    expect(existsSync(`${logPath}.1`)).toBe(false)
  })

  it('writes an oversized entry into an empty file without rotating', async () => {
    setDebugLogs(true)
    const logger = new Internals(logPath, 5, 2)
    await logger.logMessage('this is longer than the limit')

    expect(await readFile(logPath, 'utf8')).toBe(
      'this is longer than the limit\n',
    )
    expect(existsSync(`${logPath}.1`)).toBe(false)
  })

  it('appends to an existing log file', async () => {
    setDebugLogs(true)
    await Bun.write(logPath, 'existing\n')
    const logger = new Internals(logPath)
    await logger.logMessage('new')
    expect(await readFile(logPath, 'utf8')).toBe('existing\nnew\n')
  })

  it('keeps processing the queue after a failed write', async () => {
    setDebugLogs(true)
    // A file in place of the log directory makes mkdir fail.
    const blocker = join(tmpDir, 'blocker')
    await writeFile(blocker, '')
    const badLogger = new Internals(join(blocker, 'log.txt'))
    await expect(badLogger.logMessage('fail')).rejects.toBeDefined()
    await expect(badLogger.logMessage('fail again')).rejects.toBeDefined()
    await flush(badLogger)
  })
})

describe('logger integration with FileLogger', () => {
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    process.env.ACP_AGENTIC_DIR = tmpDir
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('writes formatted messages to the log file when debugLogs is on', async () => {
    setDebugLogs(true)
    const { logInfo, logWarning, logError } = await loadLogger('INFO')
    logInfo('info message', { a: 1 })
    logWarning('warn message')
    logError('error message', new Error('boom'))
    await flush(FileLogger.getInstance())

    const content = await readFile(
      join(tmpDir, 'logs', 'indexer_log.txt'),
      'utf8',
    )
    expect(content).toContain('[INFO] info message {\n  "a": 1\n}')
    expect(content).toContain('[WARNING] warn message')
    expect(content).toContain('[ERROR] error message Error: boom')
    expect(content.indexOf('[INFO]')).toBeLessThan(content.indexOf('[WARNING]'))
    expect(content.indexOf('[WARNING]')).toBeLessThan(
      content.indexOf('[ERROR]'),
    )
    expect(errorSpy).toHaveBeenCalledTimes(3)
  })

  it('still logs to console but not to file when debugLogs is off', async () => {
    setDebugLogs(false)
    const { logInfo } = await loadLogger('INFO')
    logInfo('console only')
    await flush(FileLogger.getInstance())

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(existsSync(join(tmpDir, 'logs', 'indexer_log.txt'))).toBe(false)
  })

  it('respects the log level filter (debug suppressed by default)', async () => {
    setDebugLogs(true)
    const { logDebug } = await loadLogger('INFO')
    logDebug('hidden debug')
    await flush(FileLogger.getInstance())

    expect(errorSpy).not.toHaveBeenCalled()
    expect(existsSync(join(tmpDir, 'logs', 'indexer_log.txt'))).toBe(false)
  })
})
