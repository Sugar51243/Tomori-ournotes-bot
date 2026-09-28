import { config } from './config';

const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = levels[config.logLevel] ?? 1;

function stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function logger(type: string, message: unknown): void {
    let level = 'info';
    if (type.includes('Error') || type.includes('error')) level = 'error';
    else if (type.includes('warn') || type.includes('Warn')) level = 'warn';
    if ((levels[level] ?? 1) < minLevel) return;
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
    console.log(`[${stamp()}] [${type}] ${text}`);
}
