import type { LogLevel } from './types';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, info: 2, debug: 3 };

let current: LogLevel = 'error';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return ORDER[current] >= ORDER[level];
}

const PREFIX = '%c[dom-modifier]';
const STYLE = 'color:#8b5cf6;font-weight:600';

export const log = {
  debug(...args: unknown[]): void {
    if (enabled('debug')) console.debug(PREFIX, STYLE, ...args);
  },
  info(...args: unknown[]): void {
    if (enabled('info')) console.info(PREFIX, STYLE, ...args);
  },
  error(...args: unknown[]): void {
    if (enabled('error')) console.error(PREFIX, STYLE, ...args);
  },
  /** Always-on group used by the debug overlay; no-op unless debug. */
  group(label: string, body: () => void): void {
    if (!enabled('debug')) return;
    console.groupCollapsed(PREFIX, STYLE, label);
    try {
      body();
    } finally {
      console.groupEnd();
    }
  },
};
