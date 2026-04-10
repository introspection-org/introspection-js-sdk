import { DiagLogLevel, DiagLogger } from "@opentelemetry/api";

/**
 * Logger for introspection-sdk package.
 * Uses OpenTelemetry's diagnostic logger.
 */
class IntrospectionLogger implements DiagLogger {
  private logLevel: DiagLogLevel;

  constructor() {
    const logLevelStr = (
      process.env.INTROSPECTION_LOG_LEVEL || "INFO"
    ).toUpperCase();
    this.logLevel = this.parseLogLevel(logLevelStr);
  }

  private parseLogLevel(level: string): DiagLogLevel {
    switch (level) {
      case "ERROR":
        return DiagLogLevel.ERROR;
      case "WARN":
        return DiagLogLevel.WARN;
      case "INFO":
        return DiagLogLevel.INFO;
      case "DEBUG":
        return DiagLogLevel.DEBUG;
      case "VERBOSE":
        return DiagLogLevel.VERBOSE;
      default:
        return DiagLogLevel.INFO;
    }
  }

  private shouldLog(level: DiagLogLevel): boolean {
    return level <= this.logLevel;
  }

  error(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.ERROR)) {
      console.error("[introspection-sdk]", ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.WARN)) {
      console.warn("[introspection-sdk]", ...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.INFO)) {
      console.info("[introspection-sdk]", ...args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.DEBUG)) {
      console.debug("[introspection-sdk]", ...args);
    }
  }

  verbose(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.VERBOSE)) {
      console.debug("[introspection-sdk]", ...args);
    }
  }
}

export const logger = new IntrospectionLogger();
