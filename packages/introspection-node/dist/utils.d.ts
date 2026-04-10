import { DiagLogger } from "@opentelemetry/api";
/**
 * Logger for introspection-sdk package.
 * Uses OpenTelemetry's diagnostic logger.
 */
declare class IntrospectionLogger implements DiagLogger {
    private logLevel;
    constructor();
    private parseLogLevel;
    private shouldLog;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
    debug(...args: unknown[]): void;
    verbose(...args: unknown[]): void;
}
export declare const logger: IntrospectionLogger;
export {};
//# sourceMappingURL=utils.d.ts.map