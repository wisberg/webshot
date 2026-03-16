import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('Enter a site URL or sitemap URL to generate full-page PDF exports.');
  const [status, setStatus] = useState({
    stage: 'idle',
    message: '',
    completed: 0,
    total: 0,
    currentUrl: ''
  });
  const [logs, setLogs] = useState([]);
  const eventSourceRef = useRef(null);
  const [view, setView] = useState('home');
  const [downloadReady, setDownloadReady] = useState(false);
  const [downloadJob, setDownloadJob] = useState({ jobId: null, name: null });
  const [isDownloading, setIsDownloading] = useState(false);

  const progressPercent = useMemo(() => {
    if (!status.total) return 0;
    return Math.min(100, Math.round((status.completed / status.total) * 100));
  }, [status.completed, status.total]);

  useEffect(() => {
    const styleTag = document.createElement('style');
    styleTag.textContent = `
      * { box-sizing: border-box; }
      input::placeholder { color: #cbd5f5; }
      @keyframes progressFlow {
        0% { background-position: 0% 50%; }
        100% { background-position: 200% 50%; }
      }
    `;
    document.head.appendChild(styleTag);

    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.documentElement.style.width = '100%';
    document.documentElement.style.height = '100%';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.width = '100%';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';
    document.body.style.background = '#0b0b0f';
    document.body.style.color = '#f9fafb';
    document.body.style.fontFamily = '"Manrope", "Inter", "SF Pro Display", system-ui, sans-serif';
    return () => {
      styleTag.remove();
      document.documentElement.removeAttribute('style');
      document.body.removeAttribute('style');
    };
  }, []);

  async function startExport() {
    setMessage('Preparing export...');
    setIsLoading(true);
    setStatus({ stage: 'starting', message: 'Starting export…', completed: 0, total: 0, currentUrl: '' });
    setLogs([]);
    setDownloadReady(false);
    setDownloadJob({ jobId: null, name: null });
    setView('export');

    try {
      const response = await fetch('/api/export/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!response.ok) {
        if (response.status === 404) {
          await runLegacyExport();
          return;
        }
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Export failed.');
      }

      const payload = await response.json();
      const { jobId } = payload;
      if (!jobId) throw new Error('Export job was not created.');

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(`/api/export/stream/${jobId}`);
      eventSourceRef.current = eventSource;

      eventSource.addEventListener('progress', (event) => {
        const data = JSON.parse(event.data || '{}');
        setStatus((prev) => ({
          stage: data.stage || prev.stage,
          message: data.message || prev.message,
          completed: Number.isFinite(data.completed) ? data.completed : prev.completed,
          total: Number.isFinite(data.total) ? data.total : prev.total,
          currentUrl: data.currentUrl || prev.currentUrl
        }));
        if (data.message) {
          setLogs((prev) => [data.message, ...prev].slice(0, 6));
        }
      });

      eventSource.addEventListener('failed', (event) => {
        const data = JSON.parse(event.data || '{}');
        setMessage(`Error: ${data.error || 'Export failed.'}`);
        setStatus((prev) => ({ ...prev, stage: 'error' }));
        setIsLoading(false);
        eventSource.close();
      });

      eventSource.addEventListener('done', async (event) => {
        const data = JSON.parse(event.data || '{}');
        setMessage('Export complete. Ready to download.');
        eventSource.close();
        setDownloadReady(true);
        setDownloadJob({ jobId, name: data.archiveName || 'website_exports.zip' });
        setStatus((prev) => ({ ...prev, stage: 'done' }));
        setIsLoading(false);
      });

      eventSource.addEventListener('error', () => {
        setMessage('Connection lost while waiting for progress updates.');
      });
    } catch (error) {
      setMessage(`Error: ${error.message}`);
      setStatus((prev) => ({ ...prev, stage: 'error' }));
      setIsLoading(false);
    }
  }

  async function runLegacyExport() {
    setStatus((prev) => ({ ...prev, stage: 'fallback', message: 'Running legacy export (no live progress)…' }));
    setMessage('Running legacy export (no live progress)…');

    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Export failed.');
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const fileNameMatch = contentDisposition.match(/filename="?([^\"]+)"?/i);
    const fileName = fileNameMatch?.[1] || 'website_exports.zip';
    setDownloadReady(true);
    setDownloadJob({ jobId: null, name: fileName, legacyUrl: downloadUrl });
    setMessage('Export complete. Ready to download.');
    setStatus((prev) => ({ ...prev, stage: 'done' }));
    setIsLoading(false);
  }

  async function handleDownload() {
    if (!downloadReady) return;
    setIsDownloading(true);
    try {
      if (downloadJob.legacyUrl) {
        const link = document.createElement('a');
        link.href = downloadJob.legacyUrl;
        link.download = downloadJob.name || 'website_exports.zip';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadJob.legacyUrl);
      } else if (downloadJob.jobId) {
        await downloadZip(downloadJob.jobId, downloadJob.name);
      }
      setMessage('Download started.');
    } catch (error) {
      setMessage(`Error: ${error.message}`);
    } finally {
      setIsDownloading(false);
    }
  }

  async function downloadZip(jobId, suggestedName) {
    const response = await fetch(`/api/export/download/${jobId}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Failed to download export.');
    }

    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const fileNameMatch = contentDisposition.match(/filename="?([^\"]+)"?/i);
    const fileName = fileNameMatch?.[1] || suggestedName || 'website_exports.zip';

    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
  }

  return (
    <main style={styles.page}>
      {view === 'home' ? (
        <section style={styles.hero}>
          <div style={styles.heroInner}>
            <header style={styles.heroHeader}>
              <p style={styles.kicker}>Website Capture Suite</p>
              <h1 style={styles.heroTitle}>Capture any site, full‑page</h1>
              <p style={styles.subtitle}>
                Paste a website URL (or sitemap.xml URL), then export full-page PDFs for desktop and mobile.
              </p>
            </header>

            <div style={styles.heroInputRow}>
              <input
                style={styles.input}
                placeholder="https://example.com or https://example.com/sitemap.xml"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={isLoading}
              />
              <button style={styles.button} onClick={startExport} disabled={isLoading || !url.trim()}>
                {isLoading ? 'Running…' : 'Start Export'}
              </button>
            </div>

            <div style={styles.actions}>
              <p style={styles.helperText}>We auto-dismiss cookie banners and capture full-page screenshots.</p>
            </div>
          </div>
        </section>
      ) : (
        <section style={styles.card}>
          <div style={styles.cardInner}>
            <header style={styles.header}>
              <div>
                <p style={styles.kicker}>Website Capture Suite</p>
                <h1 style={styles.title}>Export in progress</h1>
                <p style={styles.subtitle}>
                  We are capturing and stitching each page into a full-page PDF.
                </p>
              </div>
              <div style={styles.statusBadge}>
                <span style={styles.statusDot} />
                <span style={styles.statusText}>{isLoading ? 'Processing' : 'Idle'}</span>
              </div>
            </header>

            <section style={styles.progressCard}>
              <div style={styles.progressHeader}>
                <div>
                  <p style={styles.progressLabel}>Progress</p>
                  <p style={styles.progressMessage}>{status.message || message}</p>
                </div>
                <div style={styles.progressCount}>
                  <span style={styles.progressPercent}>{progressPercent}%</span>
                  <span style={styles.progressSmall}>{status.completed}/{status.total || '–'}</span>
                </div>
              </div>
              <div style={styles.progressBar}>
                <div style={{ ...styles.progressFill, width: `${progressPercent}%` }} />
              </div>
              {status.currentUrl ? (
                <p style={styles.currentUrl}>Working on: {status.currentUrl}</p>
              ) : null}
              <div style={styles.logList}>
                {logs.length === 0 ? (
                  <p style={styles.logEmpty}>Awaiting progress updates…</p>
                ) : (
                  logs.map((log, index) => (
                    <div key={`${log}-${index}`} style={styles.logItem}>
                      <span style={styles.logBullet} />
                      <span style={styles.logText}>{log}</span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <div style={styles.exportActions}>
              <button
                style={{ ...styles.button, ...(downloadReady ? {} : styles.buttonDisabled) }}
                onClick={handleDownload}
                disabled={!downloadReady || isDownloading}
              >
                {isDownloading ? 'Preparing…' : 'Download ZIP'}
              </button>
              <button style={styles.ghostButton} onClick={() => setView('home')} disabled={isLoading}>
                Start another export
              </button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    width: '100vw',
    margin: 0,
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'stretch',
    background: 'radial-gradient(circle at top, #1f2937 0%, #0b0b0f 65%), linear-gradient(transparent 23px, rgba(255,255,255,0.04) 24px), linear-gradient(90deg, transparent 23px, rgba(255,255,255,0.04) 24px)',
    backgroundSize: 'auto, 24px 24px, 24px 24px',
    backgroundPosition: 'top center, center, center',
    color: '#f9fafb',
    fontFamily: '"Manrope", "Inter", "SF Pro Display", system-ui, sans-serif',
    padding: 0,
    overflow: 'hidden',
    boxSizing: 'border-box'
  },
  card: {
    width: '100%',
    minHeight: '100vh',
    background: '#101114',
    borderRadius: 0,
    border: 0,
    boxShadow: 'none',
    display: 'flex',
    justifyContent: 'center'
  },
  cardInner: {
    width: 'min(960px, 92vw)',
    padding: '2.4rem 0',
    display: 'grid',
    gap: '1.4rem'
  },
  hero: {
    width: '100%',
    minHeight: '100vh',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  heroInner: {
    width: 'min(860px, 92vw)',
    background: 'rgba(8,10,14,0.85)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '28px',
    padding: '3rem',
    boxShadow: '0 40px 90px rgba(0,0,0,.55)',
    display: 'grid',
    gap: '1.6rem',
    backdropFilter: 'blur(12px)'
  },
  heroHeader: {
    display: 'grid',
    gap: '.6rem'
  },
  heroTitle: {
    margin: 0,
    fontSize: '2.6rem',
    letterSpacing: '-0.01em'
  },
  heroInputRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '0.8rem',
    alignItems: 'center'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '1rem'
  },
  kicker: {
    margin: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.2em',
    fontSize: '.65rem',
    color: '#9ca3af'
  },
  title: {
    margin: 0,
    fontSize: '2rem'
  },
  subtitle: {
    margin: 0,
    color: '#9ca3af',
    lineHeight: 1.6,
    maxWidth: '32rem'
  },
  statusBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '.5rem',
    background: '#111827',
    borderRadius: '999px',
    padding: '.35rem .8rem',
    border: '1px solid #1f2937'
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#22c55e',
    boxShadow: '0 0 10px rgba(34,197,94,.6)'
  },
  statusText: {
    fontSize: '.75rem',
    color: '#e5e7eb'
  },
  inputRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '0.8rem',
    alignItems: 'center'
  },
  input: {
    borderRadius: '12px',
    border: '1px solid #374151',
    background: '#0b0d12',
    color: '#f9fafb',
    padding: '1rem 1.1rem',
    fontSize: '1rem',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.08), 0 12px 24px rgba(0,0,0,.25)',
    outline: 'none',
    letterSpacing: '0.01em'
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexWrap: 'wrap'
  },
  button: {
    border: 0,
    borderRadius: '12px',
    padding: '.9rem 1.4rem',
    fontWeight: 600,
    background: 'linear-gradient(135deg, #f9fafb 0%, #9ca3af 100%)',
    color: '#111827',
    cursor: 'pointer',
    boxShadow: '0 12px 24px rgba(0,0,0,.35)'
  },
  helperText: {
    margin: 0,
    color: '#9ca3af',
    fontSize: '.9rem'
  },
  progressCard: {
    background: '#0b0c10',
    borderRadius: '16px',
    border: '1px solid #1f2937',
    padding: '1.2rem',
    display: 'grid',
    gap: '.9rem'
  },
  progressHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem'
  },
  progressLabel: {
    margin: 0,
    color: '#9ca3af',
    fontSize: '.75rem',
    textTransform: 'uppercase',
    letterSpacing: '.16em'
  },
  progressMessage: {
    margin: 0,
    fontSize: '1rem',
    color: '#f9fafb'
  },
  progressCount: {
    textAlign: 'right'
  },
  progressPercent: {
    fontSize: '1.4rem',
    fontWeight: 600
  },
  progressSmall: {
    display: 'block',
    color: '#9ca3af',
    fontSize: '.8rem'
  },
  progressBar: {
    width: '100%',
    height: '10px',
    background: '#111827',
    borderRadius: '999px',
    overflow: 'hidden',
    border: '1px solid #1f2937'
  },
  progressFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #e5e7eb 0%, #9ca3af 40%, #e5e7eb 80%)',
    backgroundSize: '200% 100%',
    transition: 'width 200ms ease',
    animation: 'progressFlow 1.4s linear infinite'
  },
  currentUrl: {
    margin: 0,
    color: '#cbd5f5',
    fontSize: '.85rem',
    wordBreak: 'break-all'
  },
  logList: {
    display: 'grid',
    gap: '.5rem'
  },
  logEmpty: {
    margin: 0,
    color: '#6b7280',
    fontSize: '.85rem'
  },
  logItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '.5rem',
    color: '#e5e7eb',
    fontSize: '.9rem'
  },
  logBullet: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: '#4b5563'
  },
  logText: {
    flex: 1
  },
  exportActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.8rem',
    flexWrap: 'wrap'
  },
  ghostButton: {
    borderRadius: '12px',
    padding: '.9rem 1.2rem',
    background: 'transparent',
    color: '#e5e7eb',
    border: '1px solid #374151',
    cursor: 'pointer'
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
    boxShadow: 'none'
  }
};

createRoot(document.getElementById('root')).render(<App />);
