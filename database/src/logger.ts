import { config } from './config';

/** 日志等级: 数值越大越严重, 低于 config.logLevel 的直接丢弃 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function stamp(): string {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level: LogLevel, scope: string, msg: string): void {
    if (LEVELS[level] < threshold) return;
    const line = `[${stamp()}] [${level}] [${scope}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

/** 统一日志出口; scope 用模块名(如 'auth'/'mysql'/'forum'), 便于 grep */
export function logger(scope: string, msg: string, level: LogLevel = 'info'): void {
    emit(level, scope, msg);
}

/** 把任意抛出物转成一行可读文本(errno/code 一起带上, 数据库错误光看 message 不够) */
export function describeError(e: unknown): string {
    if (e instanceof Error) {
        const extra = e as Error & { code?: string; errno?: number };
        const tag = extra.code ?? (extra.errno !== undefined ? String(extra.errno) : undefined);
        return tag ? `${e.message} (${tag})` : e.message;
    }
    return String(e);
}
