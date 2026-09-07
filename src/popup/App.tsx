/**
 * Popup shell: header, tab switcher, the active pane and the bottom toolbar.
 *
 * The only local state here is presentational (which tab is showing, whether
 * the save dialog is open). Everything else comes from `useController`, so a
 * re-render can never disagree with the page.
 */

import { useState } from 'react';

import type { ApplyReport } from '@/shared/types';
import { originOf, pathOf } from '@/shared/url-match';

import { Header } from './components/Header';
import { IconWarning } from './components/Icons';
import { RecordPanel } from './components/RecordPanel';
import { SaveDialog } from './components/SaveDialog';
import { SettingsPanel } from './components/SettingsPanel';
import { SnapshotList } from './components/SnapshotList';
import { Toolbar } from './components/Toolbar';
import { useController } from './hooks/useController';

type TabKey = 'record' | 'snapshots' | 'settings';

/**
 * Hằng số, không phải `[]` viết thẳng trong JSX: mảng mới mỗi lần render sẽ phá
 * `useMemo` bên trong RecordPanel ở mọi lượt poll.
 */
const EMPTY_REPORTS: ApplyReport[] = [];

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'record', label: 'Record' },
  { key: 'snapshots', label: 'Snapshots' },
  { key: 'settings', label: 'Settings' },
];

/** Root component mounted into #root by `main.tsx`. */
export function App() {
  const c = useController();
  const [tab, setTab] = useState<TabKey>('record');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const url = c.tab?.url ?? '';
  const origin = c.state?.origin ?? originOf(url);
  const path = c.state?.path ?? pathOf(url);
  const connected = !c.unavailable && c.state !== null;
  const pending = c.state?.pending ?? [];
  const enabledPending = pending.filter((change) => change.enabled);

  if (c.loading) {
    return <div className="loading">Đang kết nối…</div>;
  }

  return (
    <div className="app">
      <Header
        origin={origin}
        path={path}
        connected={connected}
        enabled={c.settings.enabled}
        onToggleEnabled={(enabled) => c.updateSettings({ enabled })}
      />

      {c.error ? (
        <div className="banner">
          <IconWarning size={12} />
          <span>{c.error}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="banner ok">
          <span>{notice}</span>
          <span className="spacer" />
          <button type="button" className="linkish" onClick={() => setNotice(null)}>
            Ẩn
          </button>
        </div>
      ) : null}

      <nav className="tabs">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={tab === entry.key ? 'tab active' : 'tab'}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            {entry.key === 'record' && pending.length > 0 ? (
              <span className="tab-count">{pending.length}</span>
            ) : null}
            {entry.key === 'snapshots' && c.snapshots.length > 0 ? (
              <span className="tab-count">{c.snapshots.length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {tab === 'record' ? (
          <RecordPanel
            recording={c.state?.recording ?? false}
            pending={pending}
            filteredOut={c.state?.filteredOut ?? 0}
            restoredCount={c.state?.restoredCount ?? 0}
            draftSavedAt={c.state?.draftSavedAt ?? null}
            autoDraft={c.settings.autoDraft}
            reports={c.state?.reports ?? EMPTY_REPORTS}
            connected={connected}
            onStart={c.startRecording}
            onStop={c.stopRecording}
            onClear={c.clearPending}
            onToggle={c.togglePending}
            onDelete={c.deletePending}
            onSetAll={c.setAllPending}
            onLocate={(changeId) => c.highlight(changeId)}
            onRequestSave={() => setSaving(true)}
          />
        ) : null}

        {tab === 'snapshots' ? (
          <SnapshotList
            snapshots={c.snapshots}
            matching={c.matching}
            activeSnapshots={c.state?.activeSnapshots ?? []}
            onToggle={c.toggleSnapshot}
            onRename={c.renameSnapshot}
            onDelete={c.deleteSnapshot}
            onToggleChange={c.toggleSnapshotChange}
            onDeleteChange={c.deleteSnapshotChange}
            onExport={c.exportSnapshots}
            onImport={(file) => {
              void c.importSnapshots(file).then((imported) => {
                setNotice(
                  imported > 0
                    ? `Đã nhập ${imported} snapshot.`
                    : 'Không nhập được snapshot nào từ file này.',
                );
              });
            }}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsPanel settings={c.settings} onChange={c.updateSettings} />
        ) : null}
      </main>

      <Toolbar
        stats={c.state?.stats ?? null}
        disabled={!connected}
        onReplay={c.runReplay}
        onRevert={c.revertReplay}
      />

      {saving ? (
        <SaveDialog
          url={url}
          pageTitle={c.tab?.title ?? ''}
          count={enabledPending.length}
          snapshots={c.snapshots}
          onCancel={() => setSaving(false)}
          onSave={(input) => {
            setSaving(false);
            void c.saveSnapshot(input).then((snapshot) => {
              if (snapshot) {
                setNotice(`Đã lưu “${snapshot.name}”.`);
                setTab('snapshots');
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}
