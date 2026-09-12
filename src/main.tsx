import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import { SimulationBridge } from './app/bridge';
import type { Snapshot } from './shared/types';

const SAVE_KEY = 'future-transit-save-v1';
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <main
        style={{ padding: 40, fontFamily: 'sans-serif', background: '#f4f3ec', minHeight: '100vh' }}
      >
        <h1>暂时无法打开城市 / Unable to open the city</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>重新加载 / Reload</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function GameRoot() {
  const [bridge] = useState(() => new SimulationBridge());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const unsub = bridge.subscribe(setSnapshot),
      offError = bridge.onError((e) => setError(e.message));
    let active = true;
    try {
      const data = localStorage.getItem(SAVE_KEY);
      if (data)
        void bridge.load(data).catch(() => {
          let backedUp = false;
          try {
            const backupKey = `future-transit-previous-prototype-${Date.now()}`;
            localStorage.setItem(backupKey, data);
            localStorage.removeItem(SAVE_KEY);
            backedUp = true;
          } catch {
            /* Keep existing storage if a backup cannot be written. */
          }
          if (active)
            setError(
              document.documentElement.lang === 'en'
                ? backedUp
                  ? 'Previous prototype saved as a backup. A new city is ready.'
                  : 'This save is incompatible. A new city is ready.'
                : backedUp
                  ? '早期原型存档已备份，新城市已就绪。'
                  : '该存档版本不兼容，当前为新城市。',
            );
        });
    } catch {
      /* Storage is optional. */
    }
    const onVisibility = () => {
      if (document.hidden)
        void bridge.command({ type: 'setRunning', value: false }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisibility);
    const autosave = setInterval(() => {
      void bridge
        .save()
        .then((data) => {
          try {
            localStorage.setItem(SAVE_KEY, data);
          } catch {
            /* Storage quota does not stop the game. */
          }
        })
        .catch(() => {});
    }, 30000);
    return () => {
      active = false;
      clearInterval(autosave);
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      offError();
      bridge.destroy();
    };
  }, [bridge]);
  async function save() {
    const data = await bridge.save();
    try {
      localStorage.setItem(SAVE_KEY, data);
    } catch {
      /* Download remains available. */
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `future-transit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function load(file: File) {
    if (file.size > 10 * 1024 * 1024) throw new Error('存档过大 / Save exceeds 10 MB');
    const data = await file.text();
    const result = await bridge.load(data);
    if (!result.ok) throw new Error(result.message?.zh ?? 'Load failed');
    try {
      localStorage.setItem(SAVE_KEY, data);
    } catch {
      /* optional */
    }
    setError('');
  }
  async function reset() {
    await bridge.reset();
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* optional */
    }
    setError('');
  }
  if (!snapshot)
    return (
      <div
        style={{
          background: '#f4f3ec',
          color: '#274e43',
          height: '100vh',
          display: 'grid',
          placeContent: 'center',
          fontFamily: 'sans-serif',
          textAlign: 'center',
        }}
      >
        <h1 style={{ letterSpacing: 6, fontSize: 24 }}>FUTURE TRANSIT</h1>
        <p>{error || '正在唤醒青湾市 · Bringing Bayhaven to life'}</p>
      </div>
    );
  return (
    <>
      {error && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            zIndex: 1000,
            top: 78,
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: 'calc(100vw - 32px)',
            width: 'max-content',
            padding: '10px 14px',
            borderRadius: 14,
            boxShadow: '0 4px 24px #30483b22',
            background: '#fff8e9',
            color: '#4b3828',
            fontSize: 12,
          }}
        >
          {error}
          <button
            aria-label="关闭 / Dismiss"
            style={{ marginLeft: 12, background: 'transparent', fontSize: 16 }}
            onClick={() => setError('')}
          >
            ×
          </button>
        </div>
      )}
      <App
        snapshot={snapshot}
        onCommand={(command) => bridge.command(command)}
        onSave={save}
        onLoad={load}
        onReset={reset}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <GameRoot />
  </ErrorBoundary>,
);
