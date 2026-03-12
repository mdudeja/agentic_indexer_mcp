import { getNow } from "./datetime";

// Log levels
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  NONE = 4,
}

const CURRENT_LOG_LEVEL = parseLogLevel(process.env.LOG_LEVEL);
const log_types = ["log", "error", "warn", "info"] as const;
export type LogType = (typeof log_types)[number];

/**
 * Parse log level from environment variable
 */
function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) return LogLevel.INFO; // default level

  switch (level.toUpperCase()) {
    case "DEBUG":
      return LogLevel.DEBUG;
    case "INFO":
      return LogLevel.INFO;
    case "WARNING":
    case "WARN":
      return LogLevel.WARNING;
    case "ERROR":
      return LogLevel.ERROR;
    case "NONE":
      return LogLevel.NONE;
    default:
      return LogLevel.INFO;
  }
}

/**
 * Format log message with timestamp and level
 */
function formatMessage(
  level: string,
  message: string,
  ...args: unknown[]
): string {
  const now = getNow();
  const argString =
    args.length > 0
      ? " " +
        args
          .map((arg) => {
            if (typeof arg === "object") {
              if (arg instanceof Error) {
                return `${arg.name}: ${arg.message}\n${arg.stack}`;
              }
              try {
                return JSON.stringify(arg, null, 2);
              } catch {
                return String(arg);
              }
            }
            return String(arg);
          })
          .join(" ")
      : "";

  return `[AgIdxr] [${now}] [${level}] ${message}${argString}`;
}

/**
 * Check if a message should be logged based on the current log level
 */
function shouldLog(messageLevel: LogLevel): boolean {
  return messageLevel >= CURRENT_LOG_LEVEL;
}

/**
 * General log function (INFO level).
 * Uses console.error to not break JSON-RPC communication over stdio
 */
export function log(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.INFO)) {
    const formatted = formatMessage("INFO", message, ...args);
    console.error(formatted);
  }
}

/**
 * Log error messages.
 * Uses console.error to not break JSON-RPC communication over stdio
 */
export function logError(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.ERROR)) {
    const formatted = formatMessage("ERROR", message, ...args);
    console.error(formatted);
  }
}

/**
 * Log warning messages.
 * Uses console.error to not break JSON-RPC communication over stdio
 */
export function logWarning(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.WARNING)) {
    const formatted = formatMessage("WARNING", message, ...args);
    console.error(formatted);
  }
}

/**
 * Log info messages.
 * Uses console.error to not break JSON-RPC communication over stdio
 */
export function logInfo(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.INFO)) {
    const formatted = formatMessage("INFO", message, ...args);
    console.error(formatted);
  }
}

/**
 * Log debug messages.
 * Uses console.error to not break JSON-RPC communication over stdio
 */
export function logDebug(message: string, ...args: unknown[]): void {
  if (shouldLog(LogLevel.DEBUG)) {
    const formatted = formatMessage("DEBUG", message, ...args);
    console.error(formatted);
  }
}
