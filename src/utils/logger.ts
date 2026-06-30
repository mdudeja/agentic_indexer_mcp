import { getNow } from './datetime'

// Log levels
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  NONE = 4,
}

const CURRENT_LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL)

/** Parses a log level string into its corresponding standard value, defaulting to INFO if unspecified or unrecognized. */
function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) return LogLevel.INFO // default level

  switch (level.toUpperCase()) {
    case 'DEBUG':
      return LogLevel.DEBUG
    case 'INFO':
      return LogLevel.INFO
    case 'WARNING':
    case 'WARN':
      return LogLevel.WARNING
    case 'ERROR':
      return LogLevel.ERROR
    case 'NONE':
      return LogLevel.NONE
    default:
      return LogLevel.INFO
  }
}

/** Purpose: Creates a formatted log message including severity level, timestamp, message, and additional context from provided arguments. */
function formatMessage(
  level: string,
  message: string,
  ...args: unknown[]
): string {
  const now = getNow()
  const argString =
    args.length > 0
      ? ' ' +
        args
          .map((arg) => {
            if (typeof arg === 'object') {
              if (arg instanceof Error) {
                return `${arg.name}: ${arg.message}\n${arg.stack}`
              }
              try {
                return JSON.stringify(arg, null, 2)
              } catch {
                return String(arg)
              }
            }
            return String(arg)
          })
          .join(' ')
      : ''

  return `[AgIdxr] [${now}] [${level}] ${message}${argString}`
}

/** Determines whether a log message with the specified level should be logged. */
function shouldLog(messageLevel: LogLevel): boolean {
  return messageLevel >= CURRENT_LOG_LEVEL
}

/** Log an error message with optional additional arguments. */
export function logError(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.ERROR)) {
    const formatted = formatMessage('ERROR', message, ...args)
    console.error(formatted)
  }
}

/** Logs a warning message. */
export function logWarning(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.WARNING)) {
    const formatted = formatMessage('WARNING', message, ...args)
    console.error(formatted)
  }
}

/** Log informational messages to the console. */
export function logInfo(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.INFO)) {
    const formatted = formatMessage('INFO', message, ...args)
    console.error(formatted)
  }
}

/** Log a message at the DEBUG level if debugging is enabled. */
export function logDebug(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.DEBUG)) {
    const formatted = formatMessage('DEBUG', message, ...args)
    console.error(formatted)
  }
}
