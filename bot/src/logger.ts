import { config } from './config';

const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = levels[config.logLevel] ?? 1;

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 统一日志出口: 按 LOG_LEVEL 过滤后打印一行带时间戳的日志。
 * @param type 日志类别(如 'app' / 'cutoff' / 'expressMainThread'); 类别名里含 error/warn 时自动升到对应等级
 * @param message 日志内容; Error 对象会打印堆栈
 */
export function logger(type: string, message: unknown): void {
    let level = 'info';
    if (type.includes('Error') || type.includes('error')) level = 'error';
    else if (type.includes('warn') || type.includes('Warn')) level = 'warn';
    if ((levels[level] ?? 1) < minLevel) return;
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
    console.log(`[${stamp()}] [${type}] ${text}`);
}
