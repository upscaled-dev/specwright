import * as vscode from "vscode";
import { LogData } from "../types";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const HOST_LEVEL: Record<LogLevel, vscode.LogLevel> = {
  [LogLevel.DEBUG]: vscode.LogLevel.Debug,
  [LogLevel.INFO]: vscode.LogLevel.Info,
  [LogLevel.WARN]: vscode.LogLevel.Warning,
  [LogLevel.ERROR]: vscode.LogLevel.Error,
};

function isLogOutputChannel(channel: vscode.OutputChannel): channel is vscode.LogOutputChannel {
  const candidate = channel as Partial<vscode.LogOutputChannel>;
  return typeof candidate.debug === "function" &&
    typeof candidate.info === "function" &&
    typeof candidate.warn === "function" &&
    typeof candidate.error === "function";
}

export class Logger {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly logOutputChannel: vscode.LogOutputChannel | undefined;
  private readonly logLevel: LogLevel;
  private readonly useHostLogLevel: boolean;

  constructor(outputChannel?: vscode.OutputChannel, initialLogLevel?: LogLevel) {
    this.outputChannel = outputChannel ?? vscode.window.createOutputChannel("Specwright", { log: true });
    this.logOutputChannel = isLogOutputChannel(this.outputChannel) ? this.outputChannel : undefined;
    this.logLevel = initialLogLevel ?? LogLevel.INFO;
    this.useHostLogLevel = initialLogLevel === undefined && this.logOutputChannel !== undefined;
  }

  public static create(outputChannel?: vscode.OutputChannel, initialLogLevel?: LogLevel): Logger {
    return new Logger(outputChannel, initialLogLevel);
  }

  public debug(message: string, data?: LogData): void {
    if (this.shouldLog(LogLevel.DEBUG)) {this.log(LogLevel.DEBUG, "DEBUG", message, data);}
  }

  public info(message: string, data?: LogData): void {
    if (this.shouldLog(LogLevel.INFO)) {this.log(LogLevel.INFO, "INFO", message, data);}
  }

  public warn(message: string, data?: LogData): void {
    if (this.shouldLog(LogLevel.WARN)) {this.log(LogLevel.WARN, "WARN", message, data);}
  }

  public error(message: string, data?: LogData): void {
    if (this.shouldLog(LogLevel.ERROR)) {this.log(LogLevel.ERROR, "ERROR", message, data);}
  }

  // Rendering happens before the channel filters, so honor the host level here:
  // otherwise every debug() call pays safeStringify only for VS Code to discard it.
  private shouldLog(level: LogLevel): boolean {
    if (!this.useHostLogLevel) {return this.logLevel <= level;}
    const host = this.logOutputChannel?.logLevel;
    if (host === undefined) {return true;}
    return host !== vscode.LogLevel.Off && host <= HOST_LEVEL[level];
  }

  private log(level: LogLevel, label: string, message: string, data?: LogData): void {
    if (this.logOutputChannel) {
      const rendered = data ? `${message}\n${Logger.safeStringify(data)}` : message;
      if (level === LogLevel.DEBUG) {this.logOutputChannel.debug(rendered);}
      else if (level === LogLevel.INFO) {this.logOutputChannel.info(rendered);}
      else if (level === LogLevel.WARN) {this.logOutputChannel.warn(rendered);}
      else {this.logOutputChannel.error(rendered);}
      return;
    }

    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] [${label}] ${message}`);
    if (data) {this.outputChannel.appendLine(Logger.safeStringify(data));}
  }

  // JSON.stringify throws on circular structures (turning a log call into the crash) and
  // serializes Error instances as {}.
  private static safeStringify(data: LogData): string {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      data,
      (_key, value: unknown) => {
        if (value instanceof Error) {
          return { name: value.name, message: value.message, stack: value.stack };
        }
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        return value;
      },
      2
    );
  }

  public showOutput(): void {
    this.outputChannel.show();
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}
