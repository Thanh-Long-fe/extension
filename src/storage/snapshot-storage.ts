/**
 * The extension's single owner of `chrome.storage`.
 *
 * Why this exists as one module:
 *  - MV3 service workers are killed and restarted at will, so every read has to
 *    tolerate a half-initialised / torn-down `chrome` namespace instead of
 *    throwing an opaque "Cannot read properties of undefined".
 *  - `chrome.storage` has no transactions. Two popup clicks in the same tick
 *    both read the old record and the second write silently drops the first
 *    one's edit. Everything mutating therefore goes through one promise-chained
 *    queue that serialises read-modify-write cycles.
 *  - Persisted records outlive the code that wrote them, so everything coming
 *    back out of storage is treated as `unknown` and re-validated.
 *
 * Only the background service worker imports this; the content script and the
 * popup reach it through the message protocol. It has no DOM or React
 * dependency, so importing it anywhere else is still safe.
 */

import type {
  AncestorFingerprint,
  AttributeChange,
  Change,
  ChangeSource,
  ChangeType,
  ClassChange,
  DraftEntry,
  DraftRecord,
  ElementFingerprint,
  ExportBundle,
  InsertChange,
  InsertPosition,
  LogLevel,
  RecordFilter,
  RemoveChange,
  Settings,
  Snapshot,
  StorageShape,
  StyleChange,
  TextChange,
  UrlMatchMode,
  VisibilityChange,
} from '@/shared/types';
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@/shared/types';
import {
  ANCESTOR_DEPTH,
  CONFIDENCE,
  MAX_ANCESTOR_VOLATILE_CLASSES,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_CHANGES,
  MAX_DRAFT_ROUTES,
  MAX_VOLATILE_CLASSES,
} from '@/shared/constants';
import { routeKeyOf, snapshotMatches } from '@/shared/url-match';
import { changeKey } from '@/shared/change-key';
import { uid } from '@/shared/id';
import { log } from '@/shared/logger';

/* ========================================================================== */
/* Keys                                                                       */
/* ========================================================================== */

const K_SCHEMA = 'schemaVersion';
const K_SNAPSHOTS = 'snapshots';
const K_SETTINGS = 'settings';

/** Prefix for the per-tab recording flag in `chrome.storage.session`. */
const REC_PREFIX = 'rec:';

/** Tiền tố khoá bản nháp per-tab trong `chrome.storage.session`. */
const DRAFT_PREFIX = 'draft:';

/* ========================================================================== */
/* chrome.storage access, guarded                                             */
/* ========================================================================== */

/**
 * Resolve a storage area defensively.
 *
 * After an extension reload (or while the worker is being torn down) `chrome`
 * can be missing entirely, and touching it throws. Callers get `null` and turn
 * that into a readable Error instead of a stack trace from deep inside Chrome.
 */
function area(name: 'local' | 'session'): chrome.storage.StorageArea | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    const found = name === 'local' ? chrome.storage.local : chrome.storage.session;
    return found ?? null;
  } catch {
    return null;
  }
}

/** `chrome.runtime.lastError` is only readable while the extension context lives. */
function lastErrorMessage(): string | undefined {
  try {
    return typeof chrome !== 'undefined' ? chrome.runtime?.lastError?.message : undefined;
  } catch {
    return undefined;
  }
}

function storageError(op: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`dom-modifier: storage ${op} failed (${detail})`);
}

async function localGet(keys: string[]): Promise<Record<string, unknown>> {
  const local = area('local');
  if (!local) throw storageError('read', 'chrome.storage.local is unavailable');
  try {
    const result: Record<string, unknown> = await local.get(keys);
    const err = lastErrorMessage();
    if (err) throw new Error(err);
    return result ?? {};
  } catch (e) {
    throw storageError('read', e);
  }
}

async function localSet(items: Record<string, unknown>): Promise<void> {
  const local = area('local');
  if (!local) throw storageError('write', 'chrome.storage.local is unavailable');
  try {
    await local.set(items);
    const err = lastErrorMessage();
    if (err) throw new Error(err);
  } catch (e) {
    throw storageError('write', e);
  }
}

/* ========================================================================== */
/* Write queue                                                                */
/* ========================================================================== */

/**
 * Serialises every read-modify-write cycle.
 *
 * Reads go through it too: that costs nothing measurable and guarantees a
 * caller reading right after a write sees that write, which is what the popup
 * (click -> mutate -> re-render from storage) depends on.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  // Keep the chain alive after a failed task, and never leave it rejected.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ========================================================================== */
/* Primitive coercion helpers                                                 */
/* ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Optional fingerprint fields treat "" and non-strings alike: absent. */
function optStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `null` is meaningful for attribute values ("remove me"), `undefined` is not. */
function strOrNull(value: unknown): string | null | undefined {
  if (typeof value === 'string') return value;
  if (value === null) return null;
  return undefined;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function intOr(value: unknown, fallback: number): number {
  return Math.trunc(numOr(value, fallback));
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'info', 'debug'];
const RECORD_FILTERS: readonly RecordFilter[] = ['all', 'likely', 'strict'];
const MATCH_MODES: readonly UrlMatchMode[] = ['origin', 'path', 'url'];
const CHANGE_TYPES: readonly ChangeType[] = [
  'text',
  'attribute',
  'style',
  'class',
  'visibility',
  'remove',
  'insert',
];
const CHANGE_SOURCES: readonly ChangeSource[] = ['devtools', 'app', 'manual'];
const INSERT_POSITIONS: readonly InsertPosition[] = ['before', 'after', 'firstChild', 'lastChild'];

/* ========================================================================== */
/* Validation / normalisation of persisted records                            */
/* ========================================================================== */

/**
 * Settings are merged over `DEFAULT_SETTINGS` (so a key added in a later
 * version gets a sane value instead of `undefined`) and every field is range-
 * or enum-checked, because a corrupted number here would poison the matcher.
 */
function coerceSettings(raw: unknown): Settings {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};

  // Di trú giá trị mặc định cũ: 300 từng là default và bị GHI HẲN vào storage
  // lúc cài đặt, nên chỉ đổi DEFAULT_SETTINGS thì người dùng cũ vẫn phải chờ
  // 300ms sau mỗi lần reload. Đúng 300 được coi là "default cũ, chưa ai đụng"
  // và nâng lên default mới; ai thật sự muốn trễ thì chọn bất kỳ số nào khác.
  const initialDelay = src.initialDelayMs === 300 ? DEFAULT_SETTINGS.initialDelayMs : src.initialDelayMs;

  return {
    enabled: boolOr(src.enabled, DEFAULT_SETTINGS.enabled),
    guard: boolOr(src.guard, DEFAULT_SETTINGS.guard),
    guardDebounceMs: numIn(src.guardDebounceMs, 0, 60_000, DEFAULT_SETTINGS.guardDebounceMs),
    initialDelayMs: numIn(initialDelay, 0, 60_000, DEFAULT_SETTINGS.initialDelayMs),
    matchTimeoutMs: numIn(src.matchTimeoutMs, 0, 600_000, DEFAULT_SETTINGS.matchTimeoutMs),
    matchThreshold: numIn(src.matchThreshold, 0, 1, DEFAULT_SETTINGS.matchThreshold),
    matchMargin: numIn(src.matchMargin, 0, 1, DEFAULT_SETTINGS.matchMargin),
    recordFilter: oneOf(src.recordFilter, RECORD_FILTERS, DEFAULT_SETTINGS.recordFilter),
    autoDraft: boolOr(src.autoDraft, DEFAULT_SETTINGS.autoDraft),
    draftDevtoolsOnly: boolOr(src.draftDevtoolsOnly, DEFAULT_SETTINGS.draftDevtoolsOnly),
    showBadge: boolOr(src.showBadge, DEFAULT_SETTINGS.showBadge),
    logLevel: oneOf(src.logLevel, LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
  };
}

const OPTIONAL_FP_STRINGS = [
  'id',
  'testId',
  'role',
  'ariaLabel',
  'ariaLabelledByText',
  'name',
  'type',
  'placeholder',
  'alt',
  'title',
  'href',
  'src',
  'ownText',
  'text',
  'ownTextAlt',
  'textAlt',
  'anchorSelector',
] as const;

const OPTIONAL_ANCESTOR_STRINGS = ['id', 'role', 'ariaLabel', 'testId', 'text'] as const;

function normaliseRect(raw: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y, w, h } = raw;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return undefined;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return undefined;
  }
  return { x, y, w, h };
}

function normaliseAncestor(raw: unknown): AncestorFingerprint | null {
  if (!isRecord(raw) || typeof raw.tag !== 'string' || raw.tag.length === 0) return null;
  const ancestor: AncestorFingerprint = {
    tag: raw.tag.toLowerCase(),
    semanticClasses: strArray(raw.semanticClasses),
    childIndex: intOr(raw.childIndex, 0),
    tagIndex: intOr(raw.tagIndex, 0),
  };
  const ancestorVolatile = strArray(raw.volatileClasses);
  if (ancestorVolatile.length > 0) {
    ancestor.volatileClasses = ancestorVolatile.slice(0, MAX_ANCESTOR_VOLATILE_CLASSES);
  }
  for (const key of OPTIONAL_ANCESTOR_STRINGS) {
    const value = optStr(raw[key]);
    if (value !== undefined) ancestor[key] = value;
  }
  return ancestor;
}

function normaliseAncestors(raw: unknown): AncestorFingerprint[] {
  if (!Array.isArray(raw)) return [];
  const out: AncestorFingerprint[] = [];
  for (const entry of raw) {
    const ancestor = normaliseAncestor(entry);
    if (ancestor) out.push(ancestor);
    if (out.length >= ANCESTOR_DEPTH) break;
  }
  return out;
}

/** A fingerprint without a tag cannot be matched against anything: drop it. */
function normaliseFingerprint(raw: unknown): ElementFingerprint | null {
  if (!isRecord(raw) || typeof raw.tag !== 'string' || raw.tag.length === 0) return null;
  const fp: ElementFingerprint = {
    v: 1,
    tag: raw.tag.toLowerCase(),
    semanticClasses: strArray(raw.semanticClasses),
    classCount: Math.max(0, intOr(raw.classCount, 0)),
    attrKeys: strArray(raw.attrKeys),
    textLen: Math.max(0, intOr(raw.textLen, 0)),
    childIndex: intOr(raw.childIndex, 0),
    tagIndex: intOr(raw.tagIndex, 0),
    depth: intOr(raw.depth, 0),
    childTagSignature: str(raw.childTagSignature, ''),
    ancestors: normaliseAncestors(raw.ancestors),
    path: str(raw.path, ''),
  };
  for (const key of OPTIONAL_FP_STRINGS) {
    const value = optStr(raw[key]);
    if (value !== undefined) fp[key] = value;
  }
  const volatileClasses = strArray(raw.volatileClasses);
  if (volatileClasses.length > 0) {
    fp.volatileClasses = volatileClasses.slice(0, MAX_VOLATILE_CLASSES);
  }
  // Chỉ giữ khi thật sự là số: `textLenAlt` vắng mặt mang nghĩa "change này
  // không có trạng thái text thứ hai", khác hẳn với "dài 0 ký tự".
  if (typeof raw.textLenAlt === 'number' && Number.isFinite(raw.textLenAlt)) {
    fp.textLenAlt = Math.max(0, Math.trunc(raw.textLenAlt));
  }
  const rect = normaliseRect(raw.rect);
  if (rect) fp.rect = rect;
  return fp;
}

/**
 * Rebuild one change from untrusted storage. A change whose discriminator is
 * unusable (no attribute name, no CSS property, ...) is dropped rather than
 * repaired, because replaying a guessed target is worse than not replaying.
 */
function normaliseChange(raw: unknown): Change | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.type !== 'string') return null;
  const type = raw.type as ChangeType;
  if (!CHANGE_TYPES.includes(type)) return null;

  const target = normaliseFingerprint(raw.target);
  if (!target) return null;

  const base = {
    id: optStr(raw.id) ?? uid('chg'),
    target,
    targetLabel: str(raw.targetLabel, target.tag),
    label: str(raw.label, type),
    oldSummary: str(raw.oldSummary, ''),
    newSummary: str(raw.newSummary, ''),
    createdAt: numOr(raw.createdAt, Date.now()),
    enabled: boolOr(raw.enabled, true),
    confidence: numIn(raw.confidence, 0, 1, CONFIDENCE.uncertain),
    source: oneOf(raw.source, CHANGE_SOURCES, 'manual'),
  };

  switch (type) {
    case 'text': {
      if (typeof raw.value !== 'string') return null;
      const change: TextChange = {
        ...base,
        type,
        value: raw.value,
        oldValue: str(raw.oldValue, ''),
        textNodeIndex: Math.max(0, intOr(raw.textNodeIndex, 0)),
      };
      return change;
    }
    case 'attribute': {
      const attribute = optStr(raw.attribute);
      const value = strOrNull(raw.value);
      if (attribute === undefined || value === undefined) return null;
      const change: AttributeChange = {
        ...base,
        type,
        attribute,
        value,
        oldValue: strOrNull(raw.oldValue) ?? null,
      };
      return change;
    }
    case 'style': {
      const property = optStr(raw.property);
      if (property === undefined || typeof raw.value !== 'string') return null;
      const change: StyleChange = {
        ...base,
        type,
        property,
        value: raw.value,
        priority: raw.priority === 'important' ? 'important' : '',
        oldValue: str(raw.oldValue, ''),
      };
      return change;
    }
    case 'class': {
      const added = strArray(raw.added);
      const removed = strArray(raw.removed);
      if (added.length === 0 && removed.length === 0) return null;
      const change: ClassChange = { ...base, type, added, removed };
      return change;
    }
    case 'visibility': {
      const change: VisibilityChange = { ...base, type, hidden: boolOr(raw.hidden, true) };
      return change;
    }
    case 'remove': {
      const change: RemoveChange = { ...base, type, hard: boolOr(raw.hard, false) };
      return change;
    }
    case 'insert': {
      if (typeof raw.html !== 'string' || raw.html.length === 0) return null;
      const change: InsertChange = {
        ...base,
        type,
        html: raw.html,
        position: oneOf(raw.position, INSERT_POSITIONS, 'lastChild'),
      };
      return change;
    }
  }
  return null;
}

/**
 * Shape check + default fill for one snapshot record.
 * Returns `null` when the record is too broken to be worth keeping (no id).
 */
function normaliseSnapshot(raw: unknown, fallbackId?: string): Snapshot | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw.id) ?? fallbackId;
  if (!id) return null;

  const createdAt = numOr(raw.createdAt, Date.now());
  const changes: Change[] = [];
  if (Array.isArray(raw.changes)) {
    for (const entry of raw.changes) {
      const change = normaliseChange(entry);
      if (change) changes.push(change);
    }
  }

  return {
    id,
    name: str(raw.name, 'Untitled snapshot'),
    origin: str(raw.origin, ''),
    urlPattern: str(raw.urlPattern, '*') || '*',
    matchMode: oneOf(raw.matchMode, MATCH_MODES, 'path'),
    enabled: boolOr(raw.enabled, true),
    createdAt,
    updatedAt: numOr(raw.updatedAt, createdAt),
    schemaVersion: SCHEMA_VERSION,
    changes,
  };
}

/* ========================================================================== */
/* Migration                                                                  */
/* ========================================================================== */

interface MigrationResult {
  state: StorageShape;
  /** true when the normalised state differs structurally and must be persisted */
  changed: boolean;
}

/**
 * Normalise a raw storage payload into the current `StorageShape`.
 *
 * Only version 1 exists today, so this is mostly a shape check — but the seam
 * is deliberately here: a future version bump adds a `if (from < 2)` block and
 * everything downstream (readAll, every mutation) already routes through it.
 */
function migrate(raw: Record<string, unknown>): MigrationResult {
  const storedVersion = numOr(raw[K_SCHEMA], 0);
  const storedSnapshots = raw[K_SNAPSHOTS];
  const rawSnapshots: Record<string, unknown> = isRecord(storedSnapshots) ? storedSnapshots : {};

  const snapshots: Record<string, Snapshot> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(rawSnapshots)) {
    const snapshot = normaliseSnapshot(value, key);
    if (!snapshot) {
      dropped++;
      continue;
    }
    // The record key is authoritative: a mismatched inner id would make
    // getSnapshot(id) and delete(id) disagree.
    snapshot.id = key;
    snapshots[key] = snapshot;
  }

  if (dropped > 0) {
    log.error(`storage: dropped ${dropped} malformed snapshot record(s) during migration`);
  }

  return {
    state: { schemaVersion: SCHEMA_VERSION, snapshots, settings: coerceSettings(raw[K_SETTINGS]) },
    changed: storedVersion !== SCHEMA_VERSION || dropped > 0,
  };
}

/**
 * Read + migrate. Must only be called from inside the queue (directly, or via
 * `enqueue`), otherwise the migration write-back can race a mutation.
 */
async function readState(): Promise<StorageShape> {
  const raw = await localGet([K_SCHEMA, K_SNAPSHOTS, K_SETTINGS]);
  const { state, changed } = migrate(raw);
  if (changed) {
    try {
      await localSet({
        [K_SCHEMA]: state.schemaVersion,
        [K_SNAPSHOTS]: state.snapshots,
        [K_SETTINGS]: state.settings,
      });
    } catch (e) {
      // A failed write-back is not fatal: the caller still gets valid data and
      // the migration is retried on the next read.
      log.error('storage: migration write-back failed', e);
    }
  }
  return state;
}

/** Persist the snapshot map together with the schema version they were written under. */
async function writeSnapshots(snapshots: Record<string, Snapshot>): Promise<void> {
  await localSet({ [K_SCHEMA]: SCHEMA_VERSION, [K_SNAPSHOTS]: snapshots });
}

/* ========================================================================== */
/* Public: whole-state + settings                                             */
/* ========================================================================== */

/**
 * The full validated store. Every other read is built on this, so migration and
 * corruption handling happen in exactly one place.
 */
export async function readAll(): Promise<StorageShape> {
  return enqueue(() => readState());
}

/** Settings merged over `DEFAULT_SETTINGS`, so upgrades never surface `undefined`. */
export async function getSettings(): Promise<Settings> {
  const state = await readAll();
  return state.settings;
}

/**
 * Apply a partial settings patch and return the merged, validated result.
 * `undefined` values in the patch are ignored rather than resetting the key.
 */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  return enqueue(async () => {
    const state = await readState();
    const merged: Record<string, unknown> = { ...state.settings };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
    const settings = coerceSettings(merged);
    await localSet({ [K_SETTINGS]: settings });
    return settings;
  });
}

/* ========================================================================== */
/* Public: snapshot queries                                                   */
/* ========================================================================== */

/**
 * All snapshots, optionally restricted to one origin.
 * Sorted most-recently-touched first, which is the order the popup lists them.
 */
export async function listSnapshots(origin?: string): Promise<Snapshot[]> {
  const state = await readAll();
  const all = Object.values(state.snapshots);
  const filtered = origin ? all.filter((s) => s.origin === origin) : all;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/**
 * Enabled snapshots whose pattern matches `url`, oldest first.
 *
 * Apply order matters: two snapshots may touch the same element, and the newer
 * one must win, so the replayer applies them in creation order.
 */
export async function matchingSnapshots(url: string): Promise<Snapshot[]> {
  const state = await readAll();
  return Object.values(state.snapshots)
    .filter((s) => s.enabled && snapshotMatches(s, url))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** One snapshot by id, or `null` when it is gone (a popup can hold a stale id). */
export async function getSnapshot(id: string): Promise<Snapshot | null> {
  if (!id) return null;
  const state = await readAll();
  return state.snapshots[id] ?? null;
}

/* ========================================================================== */
/* Public: snapshot mutations                                                 */
/* ========================================================================== */

/**
 * Create or wholesale-replace a snapshot. The incoming object is re-validated
 * because it usually arrives over the message boundary from the content script.
 */
export async function saveSnapshot(snapshot: Snapshot): Promise<Snapshot> {
  return enqueue(async () => {
    const id = snapshot?.id || uid('snap');
    const normalised = normaliseSnapshot(snapshot, id);
    if (!normalised) throw new Error('dom-modifier: refusing to save a malformed snapshot');
    normalised.id = id;
    normalised.updatedAt = Date.now();

    const state = await readState();
    const previous = state.snapshots[id];
    if (previous) normalised.createdAt = previous.createdAt;

    state.snapshots[id] = normalised;
    await writeSnapshots(state.snapshots);
    return normalised;
  });
}

/**
 * Merge a partial patch into an existing snapshot.
 * `id` and `schemaVersion` are owned by this module and cannot be patched.
 */
export async function updateSnapshot(id: string, patch: Partial<Snapshot>): Promise<Snapshot | null> {
  return enqueue(async () => {
    const state = await readState();
    const current = state.snapshots[id];
    if (!current) return null;

    const merged: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'schemaVersion' || value === undefined) continue;
      merged[key] = value;
    }
    const next = normaliseSnapshot(merged, id);
    if (!next) throw new Error(`dom-modifier: patch made snapshot ${id} malformed`);
    next.id = id;
    next.createdAt = current.createdAt;
    next.updatedAt = numOr(patch.updatedAt, Date.now());

    state.snapshots[id] = next;
    await writeSnapshots(state.snapshots);
    return next;
  });
}

/** Delete a snapshot. Deleting an unknown id is a no-op, not an error. */
export async function deleteSnapshot(id: string): Promise<void> {
  await enqueue(async () => {
    const state = await readState();
    if (!(id in state.snapshots)) return;
    delete state.snapshots[id];
    await writeSnapshots(state.snapshots);
  });
}

/* ------------------------------ change identity ---------------------------- */

/**
 * `changeKey` sống ở `@/shared/change-key` vì recorder cũng cần đúng định nghĩa
 * "cùng một lần sửa" đó để gộp bản nháp khôi phục với lần sửa kế tiếp của user.
 *
 * Append changes, replacing any that re-edit a slot the snapshot already holds.
 *
 * Without this, editing one button's text five times leaves five conflicting
 * changes that the replayer would apply in sequence. A replacement keeps the
 * original id and createdAt so the popup row (and any selection on it) stays put.
 */
export async function appendChanges(
  snapshotId: string,
  changes: Change[],
): Promise<Snapshot | null> {
  return enqueue(async () => {
    const state = await readState();
    const snapshot = state.snapshots[snapshotId];
    if (!snapshot) return null;
    if (!Array.isArray(changes) || changes.length === 0) return snapshot;

    const byKey = new Map<string, number>();
    snapshot.changes.forEach((existing, index) => {
      byKey.set(changeKey(existing), index);
    });

    let touched = false;
    for (const incoming of changes) {
      const clean = normaliseChange(incoming);
      if (!clean) {
        log.error('storage: ignoring a malformed incoming change');
        continue;
      }
      const key = changeKey(clean);
      const index = byKey.get(key);
      if (index === undefined) {
        byKey.set(key, snapshot.changes.length);
        snapshot.changes.push(clean);
      } else {
        const previous = snapshot.changes[index];
        // previous is guaranteed present: index came from this same array.
        snapshot.changes[index] = previous
          ? { ...clean, id: previous.id, createdAt: previous.createdAt }
          : clean;
      }
      touched = true;
    }

    if (!touched) return snapshot;
    snapshot.updatedAt = Date.now();
    await writeSnapshots(state.snapshots);
    return snapshot;
  });
}

/** Remove one change. Returns the snapshot (unchanged if the change was gone). */
export async function deleteChange(
  snapshotId: string,
  changeId: string,
): Promise<Snapshot | null> {
  return enqueue(async () => {
    const state = await readState();
    const snapshot = state.snapshots[snapshotId];
    if (!snapshot) return null;

    const next = snapshot.changes.filter((c) => c.id !== changeId);
    if (next.length === snapshot.changes.length) return snapshot;

    snapshot.changes = next;
    snapshot.updatedAt = Date.now();
    await writeSnapshots(state.snapshots);
    return snapshot;
  });
}

/** Toggle a single change without touching the rest of the snapshot. */
export async function setChangeEnabled(
  snapshotId: string,
  changeId: string,
  enabled: boolean,
): Promise<Snapshot | null> {
  return enqueue(async () => {
    const state = await readState();
    const snapshot = state.snapshots[snapshotId];
    if (!snapshot) return null;

    const target = snapshot.changes.find((c) => c.id === changeId);
    if (!target || target.enabled === enabled) return snapshot;

    target.enabled = enabled;
    snapshot.updatedAt = Date.now();
    await writeSnapshots(state.snapshots);
    return snapshot;
  });
}

/* ========================================================================== */
/* Public: import / export                                                    */
/* ========================================================================== */

/**
 * Build a portable bundle. `ids` and `origin` compose (both applied when both
 * are given); omitting both exports everything. Sorted by createdAt so two
 * exports of the same data are byte-identical apart from `exportedAt`.
 */
export async function exportSnapshots(opts: {
  ids?: string[];
  origin?: string;
}): Promise<ExportBundle> {
  const state = await readAll();
  const wanted = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  const snapshots = Object.values(state.snapshots)
    .filter((s) => (wanted ? wanted.has(s.id) : true))
    .filter((s) => (opts.origin ? s.origin === opts.origin : true))
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    kind: 'dom-modifier-export',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    snapshots,
  };
}

/**
 * Import a bundle produced by `exportSnapshots`.
 *
 * `replace` wipes the store first; `merge` keeps what is there and re-ids any
 * incoming snapshot whose id already exists, so importing a bundle twice never
 * silently overwrites the user's edited copy. Throws with a human-readable
 * message on malformed input — the popup shows it verbatim.
 */
export async function importSnapshots(json: string, mode: 'merge' | 'replace'): Promise<number> {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`Import failed: unknown mode "${String(mode)}".`);
  }
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new Error('Import failed: the file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Import failed: the file is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new Error('Import failed: expected a JSON object at the top level.');
  }
  if (parsed.kind !== 'dom-modifier-export') {
    throw new Error('Import failed: this is not a DOM Modifier export file.');
  }
  if (!Array.isArray(parsed.snapshots)) {
    throw new Error('Import failed: the bundle has no "snapshots" array.');
  }

  const incoming = parsed.snapshots;
  const candidates: Snapshot[] = [];
  for (const entry of incoming) {
    const snapshot = normaliseSnapshot(entry, uid('snap'));
    if (snapshot) candidates.push(snapshot);
  }
  if (incoming.length > 0 && candidates.length === 0) {
    throw new Error('Import failed: none of the snapshots in the bundle are readable.');
  }

  return enqueue(async () => {
    const state = await readState();
    const snapshots: Record<string, Snapshot> = mode === 'replace' ? {} : state.snapshots;

    for (const snapshot of candidates) {
      let id = snapshot.id;
      while (id in snapshots) id = uid('snap');
      snapshot.id = id;
      snapshots[id] = snapshot;
    }

    await writeSnapshots(snapshots);
    return candidates.length;
  });
}

/* ========================================================================== */
/* Public: change notifications                                               */
/* ========================================================================== */

/**
 * Subscribe to snapshot/settings edits made anywhere (another popup window, a
 * second tab, an import). Returns an unsubscribe function; call it on teardown
 * so a suspended worker does not leak listeners across restarts.
 */
export function onSnapshotsChanged(listener: () => void): () => void {
  const onChanged = (() => {
    try {
      return typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
    } catch {
      return undefined;
    }
  })();

  if (!onChanged) {
    log.error('storage: chrome.storage.onChanged is unavailable; changes will not be observed');
    return () => undefined;
  }

  const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string): void => {
    if (areaName !== 'local') return;
    if (!(K_SNAPSHOTS in changes) && !(K_SETTINGS in changes)) return;
    try {
      listener();
    } catch (e) {
      log.error('storage: onSnapshotsChanged listener threw', e);
    }
  };

  try {
    onChanged.addListener(handler);
  } catch (e) {
    log.error('storage: could not register a storage listener', e);
    return () => undefined;
  }

  return () => {
    try {
      onChanged.removeListener(handler);
    } catch (e) {
      log.error('storage: could not remove a storage listener', e);
    }
  };
}

/* ========================================================================== */
/* Public: per-tab recording flag                                             */
/* ========================================================================== */

/**
 * Recording must survive a service-worker suspension but must NOT survive a
 * browser restart (nobody expects to still be recording tomorrow), which is
 * exactly `chrome.storage.session`. Older/odd runtimes without it fall back to
 * memory, where the flag simply dies with the worker.
 */
const memoryRecording = new Map<number, boolean>();

function recKey(tabId: number): string {
  return `${REC_PREFIX}${tabId}`;
}

/** True while the given tab is recording DevTools edits. Never throws. */
export async function getRecording(tabId: number): Promise<boolean> {
  if (!Number.isFinite(tabId)) return false;
  const session = area('session');
  if (!session) return memoryRecording.get(tabId) === true;
  try {
    const key = recKey(tabId);
    const raw: Record<string, unknown> = await session.get([key]);
    const err = lastErrorMessage();
    if (err) throw new Error(err);
    return raw?.[key] === true;
  } catch (e) {
    log.error('storage: reading the recording flag failed, using the memory fallback', e);
    return memoryRecording.get(tabId) === true;
  }
}

/** Set the per-tab recording flag; mirrored into memory as a torn-down-worker fallback. */
export async function setRecording(tabId: number, recording: boolean): Promise<void> {
  if (!Number.isFinite(tabId)) return;
  memoryRecording.set(tabId, recording);
  const session = area('session');
  if (!session) return;
  try {
    await session.set({ [recKey(tabId)]: recording });
    const err = lastErrorMessage();
    if (err) throw new Error(err);
  } catch (e) {
    log.error('storage: writing the recording flag failed', e);
  }
}

/** Forget a tab's recording flag — call it from `chrome.tabs.onRemoved`. */
export async function clearRecording(tabId: number): Promise<void> {
  if (!Number.isFinite(tabId)) return;
  memoryRecording.delete(tabId);
  const session = area('session');
  if (!session) return;
  try {
    await session.remove(recKey(tabId));
    const err = lastErrorMessage();
    if (err) throw new Error(err);
  } catch (e) {
    log.error('storage: clearing the recording flag failed', e);
  }
}

/* ========================================================================== */
/* Bản nháp: thay đổi chưa commit, tự lưu theo tab                            */
/* ========================================================================== */

/**
 * Vì sao là `chrome.storage.session` chứ không phải `local`:
 * bản nháp phải sống qua F5 và qua việc service worker bị ngủ (đó chính là mục
 * đích), nhưng KHÔNG nên sống qua lần khởi động trình duyệt kế tiếp — mở máy
 * hôm sau mà tự nhiên trang bị áp lại mấy thứ nghịch dở dang hôm qua thì đáng
 * sợ hơn là tiện. Muốn giữ lâu dài thì đã có snapshot.
 *
 * Hàng đợi riêng, không dùng chung `enqueue` với snapshot: bản nháp ghi rất dày
 * (mỗi 350ms khi user đang sửa), nếu chung hàng đợi thì thao tác lưu snapshot
 * của user sẽ phải xếp hàng sau chúng.
 */
let draftQueue: Promise<unknown> = Promise.resolve();

function enqueueDraft<T>(task: () => Promise<T>): Promise<T> {
  const run = draftQueue.then(task);
  draftQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Bản sao trong RAM, dùng khi runtime không có `chrome.storage.session`. */
const memoryDrafts = new Map<number, DraftRecord>();

function draftKey(tabId: number): string {
  return `${DRAFT_PREFIX}${tabId}`;
}

function emptyDraft(): DraftRecord {
  return { v: 1, routes: {} };
}

/** Dựng lại một `DraftRecord` từ dữ liệu không đáng tin trong storage. */
function normaliseDraft(raw: unknown): DraftRecord {
  if (!isRecord(raw) || !isRecord(raw.routes)) return emptyDraft();
  const routes: Record<string, DraftEntry> = {};
  for (const [key, value] of Object.entries(raw.routes)) {
    if (!key || !isRecord(value)) continue;
    const changes: Change[] = [];
    if (Array.isArray(value.changes)) {
      for (const entry of value.changes) {
        const change = normaliseChange(entry);
        if (change) changes.push(change);
        if (changes.length >= MAX_DRAFT_CHANGES) break;
      }
    }
    if (changes.length === 0) continue;
    routes[key] = {
      url: str(value.url, ''),
      updatedAt: numOr(value.updatedAt, 0),
      changes,
    };
  }
  return { v: 1, routes };
}

/**
 * Ép bản nháp về trong giới hạn: bỏ route cũ nhất trước, rồi nếu vẫn quá nặng
 * thì bỏ tiếp cho tới khi vừa. Route đang được sửa (`keepKey`) không bao giờ bị
 * bỏ — nó chính là thứ user vừa làm.
 */
function trimDraft(draft: DraftRecord, keepKey: string): DraftRecord {
  const entries = Object.entries(draft.routes);
  // Mới nhất trước, để `slice` cắt đúng phần cũ nhất.
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);

  let kept = entries.slice(0, MAX_DRAFT_ROUTES);
  if (!kept.some(([key]) => key === keepKey)) {
    const wanted = entries.find(([key]) => key === keepKey);
    if (wanted) kept = [wanted, ...kept.slice(0, MAX_DRAFT_ROUTES - 1)];
  }

  const size = (): number => JSON.stringify({ v: 1, routes: Object.fromEntries(kept) }).length;

  // Bước 1: bỏ bớt route cũ, trừ route đang sửa.
  while (kept.length > 1 && size() > MAX_DRAFT_BYTES) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i][0] !== keepKey) {
        victim = i;
        break;
      }
    }
    if (victim < 0) break;
    log.error('storage: bản nháp quá lớn, bỏ route', kept[victim][0]);
    kept.splice(victim, 1);
  }

  // Bước 2: chỉ còn một route mà vẫn quá to thì phải co chính nó, nếu không
  // trần dung lượng hoàn toàn vô nghĩa với tab chỉ ở một trang — mà đó lại là
  // trường hợp phổ biến nhất. Một InsertChange có thể tới 8KB, nên 200 cái là
  // thừa sức nuốt hết hạn mức 10MB của `storage.session` cho cả extension.
  // Bỏ từ ĐẦU (cũ nhất) để giữ lại thứ user vừa sửa.
  while (size() > MAX_DRAFT_BYTES) {
    const target = kept.find(([key]) => key === keepKey) ?? kept[0];
    if (!target || target[1].changes.length <= 1) break;
    const drop = Math.max(1, Math.ceil(target[1].changes.length * 0.25));
    log.error('storage: bản nháp của route quá lớn, bỏ', drop, 'thay đổi cũ nhất');
    target[1] = { ...target[1], changes: target[1].changes.slice(drop) };
  }

  return { v: 1, routes: Object.fromEntries(kept) };
}

/** Đọc bản nháp thô của một tab. Phải gọi từ trong `enqueueDraft`. */
/**
 * Kết quả đọc bản nháp.
 *
 * `ok = false` nghĩa là ĐỌC HỎNG, khác hẳn với "đọc được và rỗng". Phải phân
 * biệt hai cái đó: nếu coi lỗi đọc là rỗng rồi ghi đè lên, một trục trặc nhất
 * thời của storage sẽ biến thành xoá sạch bản nháp của mọi route trong tab.
 */
interface DraftRead {
  draft: DraftRecord;
  ok: boolean;
}

async function readDraft(tabId: number): Promise<DraftRead> {
  const session = area('session');
  if (!session) return { draft: memoryDrafts.get(tabId) ?? emptyDraft(), ok: true };
  try {
    const key = draftKey(tabId);
    const raw: Record<string, unknown> = await session.get([key]);
    const err = lastErrorMessage();
    if (err) throw new Error(err);
    return { draft: normaliseDraft(raw?.[key]), ok: true };
  } catch (e) {
    log.error('storage: đọc bản nháp thất bại, dùng bản trong RAM', e);
    const cached = memoryDrafts.get(tabId);
    // Có bản RAM thì vẫn dùng được và vẫn ghi đè được (nó chính là thứ ta ghi
    // ra lần trước). Không có gì cả thì đành chịu — nhưng KHÔNG được phép ghi
    // đè, vì ta không biết trong storage đang có gì.
    return { draft: cached ?? emptyDraft(), ok: cached !== undefined };
  }
}

/** Trả về false khi ghi hỏng, để phía gọi đừng báo cáo là đã lưu xong. */
async function writeDraft(tabId: number, draft: DraftRecord): Promise<boolean> {
  memoryDrafts.set(tabId, draft);
  const session = area('session');
  if (!session) return true;
  try {
    await session.set({ [draftKey(tabId)]: draft });
    const err = lastErrorMessage();
    if (err) throw new Error(err);
    return true;
  } catch (e) {
    log.error('storage: ghi bản nháp thất bại', e);
    return false;
  }
}

/** Các thay đổi chưa lưu của tab + route này. Không bao giờ ném lỗi. */
export async function getDraft(tabId: number, url: string): Promise<Change[]> {
  if (!Number.isFinite(tabId)) return [];
  return enqueueDraft(async () => {
    const { draft } = await readDraft(tabId);
    return draft.routes[routeKeyOf(url)]?.changes ?? [];
  });
}

/**
 * Ghi đè bản nháp của một route. Danh sách rỗng nghĩa là xoá hẳn route đó —
 * giữ lại một mục rỗng chỉ tổ chiếm chỗ của route khác.
 *
 * Trả về số change thực sự được lưu sau khi validate và cắt bớt, để phía gọi
 * biết mình có bị cắt hay không.
 */
export async function setDraft(
  tabId: number,
  url: string,
  changes: Change[],
): Promise<{ saved: number; savedAt: number }> {
  const savedAt = Date.now();
  if (!Number.isFinite(tabId)) return { saved: 0, savedAt };

  // Validate NGOÀI hàng đợi: dữ liệu đến từ content script trên trang lạ, và
  // công việc này không đụng tới storage.
  //
  // Buffer của recorder là CŨ NHẤT TRƯỚC, nên khi phải cắt thì phải cắt phần
  // đầu chứ không phải phần cuối — thứ user vừa sửa xong mới là thứ họ đau nhất
  // nếu mất, còn cái sửa từ mười phút trước thì nhiều khả năng đã lưu snapshot.
  const source = Array.isArray(changes) ? changes : [];
  const window = source.length > MAX_DRAFT_CHANGES ? source.slice(-MAX_DRAFT_CHANGES) : source;
  const clean: Change[] = [];
  for (const entry of window) {
    const change = normaliseChange(entry);
    if (change) clean.push(change);
  }

  return enqueueDraft(async () => {
    const key = routeKeyOf(url);
    const { draft, ok } = await readDraft(tabId);
    // Đọc hỏng mà không có bản RAM nào để dựa vào: ghi đè lúc này là xoá mù
    // toàn bộ bản nháp của các route khác. Thà bỏ lượt lưu này.
    if (!ok) return { saved: 0, savedAt };

    if (clean.length === 0) {
      if (!(key in draft.routes)) return { saved: 0, savedAt };
      delete draft.routes[key];
      await writeDraft(tabId, draft);
      return { saved: 0, savedAt };
    }

    draft.routes[key] = { url, updatedAt: savedAt, changes: clean };
    const trimmed = trimDraft(draft, key);
    const written = await writeDraft(tabId, trimmed);
    // Ghi hỏng thì báo 0: popup hiển thị "đã lưu lúc ..." dựa vào con số này,
    // và nói dối ở đây đúng là kiểu bug làm người ta mất việc thật.
    return { saved: written ? (trimmed.routes[key]?.changes.length ?? 0) : 0, savedAt };
  });
}

/**
 * Xoá bản nháp. Có `url` thì chỉ xoá route đó (dùng sau khi commit thành
 * snapshot); không có thì xoá cả tab (dùng khi tab đóng).
 */
export async function clearDraft(tabId: number, url?: string): Promise<void> {
  if (!Number.isFinite(tabId)) return;
  await enqueueDraft(async () => {
    if (url) {
      const { draft, ok } = await readDraft(tabId);
      // Đọc hỏng thì đừng ghi đè: xoá một route không đáng để mất các route kia.
      if (!ok) return;
      const key = routeKeyOf(url);
      if (!(key in draft.routes)) return;
      delete draft.routes[key];
      await writeDraft(tabId, draft);
      return;
    }

    memoryDrafts.delete(tabId);
    const session = area('session');
    if (!session) return;
    try {
      await session.remove(draftKey(tabId));
      const err = lastErrorMessage();
      if (err) throw new Error(err);
    } catch (e) {
      log.error('storage: xoá bản nháp thất bại', e);
    }
  });
}
