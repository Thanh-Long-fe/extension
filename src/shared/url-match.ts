import type { Snapshot, UrlMatchMode } from './types';

/** Escape everything regex-special except `*` and `?`, which become wildcards. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    })
    .join('');
  return new RegExp(`^${body}$`);
}

const regexCache = new Map<string, RegExp>();

function cachedRegExp(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/** The part of `url` a given match mode compares against. */
export function subjectFor(url: string, mode: UrlMatchMode): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  switch (mode) {
    case 'origin':
      return parsed.origin;
    case 'path':
      return parsed.pathname;
    case 'url':
      return parsed.origin + parsed.pathname + parsed.search;
  }
}

export function matchesUrl(pattern: string, mode: UrlMatchMode, url: string): boolean {
  if (!pattern) return false;
  return cachedRegExp(pattern).test(subjectFor(url, mode));
}

export function snapshotMatches(snapshot: Snapshot, url: string): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  if (snapshot.origin && snapshot.origin !== origin) return false;
  return matchesUrl(snapshot.urlPattern, snapshot.matchMode, url);
}

/** A sensible default pattern for "this page", used when saving a new snapshot. */
export function suggestPattern(url: string, mode: UrlMatchMode = 'path'): string {
  try {
    const parsed = new URL(url);
    if (mode === 'origin') return parsed.origin;
    if (mode === 'url') return parsed.origin + parsed.pathname + (parsed.search ? '*' : '');
    return parsed.pathname === '/' ? '/' : `${parsed.pathname.replace(/\/$/, '')}*`;
  } catch {
    return '*';
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/**
 * Khoá định danh một "route" cho bản nháp: origin + pathname.
 *
 * Cố tình bỏ query và hash — trên SPA chúng đổi liên tục (bộ lọc, tab con,
 * tracking param) mà DOM về cơ bản vẫn là trang đó, nên nếu tính cả chúng thì
 * mỗi lần user đổi filter là bản nháp lại "mất". URL không parse được thì trả
 * về chính chuỗi đó, vẫn dùng làm khoá được.
 */
export function routeKeyOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url || '';
  }
}
