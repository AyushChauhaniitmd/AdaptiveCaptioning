import { useState, useEffect, useRef, useCallback } from 'react';
import './UploadPanel.css';

const BACKEND = 'http://localhost:8000'; // backend defaults to 8000, serve.py on 8001
const POLL_MS  = 2000;

// ── Icons ──────────────────────────────────────────────────
const UploadIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 16 12 12 8 16"/>
    <line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

// ── Status badge steps ──────────────────────────────────────
const STEPS = ['queued', 'processing', 'done'];

export default function UploadPanel({ onVideoLoad }) {
  const [backendLive, setBackendLive]   = useState(null); // null=checking, true, false
  const [dragOver,    setDragOver]      = useState(false);
  const [videoFile,    setVideoFile]    = useState(null);
  const [subtitleFile, setSubtitleFile] = useState(null); // stores uploaded baseline SRT/VTT file
  const [manualVtt,    setManualVtt]    = useState(null); // {adaptive, baseline}
  const [jobId,       setJobId]         = useState(null);
  const [jobStatus,   setJobStatus]     = useState(null); // queued|processing|done|error
  const [jobMessage,  setJobMessage]    = useState('');
  const [error,       setError]         = useState('');
  const pollRef = useRef(null);
  const [showVideoOptions, setShowVideoOptions] = useState(false);

  // ── Health check on mount ───────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok)
      .catch(() => false)
      .then(ok => { if (!cancelled) setBackendLive(ok); });
    return () => { cancelled = true; };
  }, []);

  // ── Job polling ─────────────────────────────────────────
  useEffect(() => {
    if (!jobId || jobStatus === 'done' || jobStatus === 'error') return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${BACKEND}/status/${jobId}`);
        const d = await r.json();
        setJobStatus(d.status);
        setJobMessage(d.message || '');
        if (d.status === 'done') {
          clearInterval(pollRef.current);
          loadResult(jobId);
        } else if (d.status === 'error') {
          clearInterval(pollRef.current);
          setError(d.message || 'Pipeline error');
        }
      } catch { /* ignore transient fetch errors */ }
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [jobId, jobStatus]);

  const loadResult = async (id) => {
    try {
      const r = await fetch(`${BACKEND}/result/${id}`);
      const d = await r.json();
      // Fetch VTT text content for the custom renderer
      const [adaptiveText, baselineText] = await Promise.all([
        fetch(d.adaptive_vtt_url).then(r => r.text()).catch(() => null),
        fetch(d.baseline_vtt_url).then(r => r.text()).catch(() => null),
      ]);
      onVideoLoad(d.video_url, baselineText, adaptiveText, videoFile?.name || d.video_id);
    } catch (e) {
      setError('Failed to load pipeline result: ' + e.message);
    }
  };

  // ── Drag-and-drop handlers (still used when file is loaded) ─
  const onDragOver  = useCallback(e => { e.preventDefault(); setDragOver(true);  }, []);
  const onDragLeave = useCallback(e => { e.preventDefault(); setDragOver(false); }, []);
  const onDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) {
      setVideoFile(f);
      onVideoLoad(URL.createObjectURL(f), manualVtt?.baseline || null, manualVtt?.adaptive || null, f.name);
    } else setError('Please drop a video file (mp4, webm…)');
  }, [manualVtt, onVideoLoad]);

  // ── Manual VTT load (no backend) ─────────────────────
  const readVttFile = (file, track) => {
    if (!file) return;
    if (track === 'baseline') {
      setSubtitleFile(file);
    }
    const reader = new FileReader();
    reader.onload = e => {
      const content = e.target.result;
      setManualVtt(prev => {
        const next = { ...prev, [track]: content };
        if (videoFile) {
          const url = URL.createObjectURL(videoFile);
          onVideoLoad(url, next.baseline || null, next.adaptive || null, videoFile?.name);
        } else {
          onVideoLoad(null, next.baseline || null, next.adaptive || null, file.name);
        }
        return next;
      });
    };
    reader.readAsText(file);
  };

  const applyManualVtts = () => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    onVideoLoad(url, manualVtt?.baseline || null, manualVtt?.adaptive || null, videoFile?.name);
  };

  // ── Generate subtitles (live backend) ─────────────────
  const handleGenerate = async () => {
    if (!videoFile) {
      setError('Please upload a video file first.');
      return;
    }
    setError('');
    setJobId(null);
    setJobStatus(null);
    setJobMessage('');
    try {
      const fd = new FormData();
      fd.append('video', videoFile);
      if (subtitleFile) {
        fd.append('subtitle', subtitleFile);
      }
      const r = await fetch(`${BACKEND}/process`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(await r.text());
      const { job_id } = await r.json();
      setJobId(job_id);
      setJobStatus('queued');
    } catch (e) {
      setError('Failed to start job: ' + e.message);
    }
  };

  const clearFile = () => {
    setVideoFile(null); setManualVtt(null); setSubtitleFile(null);
    setJobId(null); setJobStatus(null); setJobMessage(''); setError('');
  };

  // ── Render ────────────────────────────────────────────
  const stepIndex = STEPS.indexOf(jobStatus);

  return (
    <div className="upload-panel">

      {/* ── Backend status banner ── */}
      {backendLive === false && (
        <div className="upload-banner upload-banner--demo">
          <AlertIcon />
          <div>
            <strong>Live processing runs locally.</strong>{' '}
            Clone the repo and run <code>uvicorn backend.main:app --port 8000</code> to process your own videos.
            In the meantime, explore the demo videos below — or manually upload a video + VTT files to compare placements.
          </div>
        </div>
      )}


      {/* Hidden inputs — no visible UI, triggered programmatically from App.jsx header buttons */}
      <input
        id="up-video"
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={e => {
          const f = e.target.files[0];
          if (!f) return;
          setVideoFile(f);
          // immediately load into VideoPlayer preserving any existing baseline SRT
          onVideoLoad(URL.createObjectURL(f), manualVtt?.baseline || null, manualVtt?.adaptive || null, f.name);
          // reset input so same file can be re-picked
          e.target.value = '';
        }}
      />

      {/* ── Hidden buttons triggered by App.jsx ── */}
      <button id="hidden-generate-btn" style={{ display: 'none' }} onClick={handleGenerate} />
      <input id="up-adaptive" type="file" accept=".vtt,.srt" style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files[0]) readVttFile(e.target.files[0], 'adaptive');
          e.target.value = '';
        }} />
      <input id="up-baseline" type="file" accept=".vtt,.srt" style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files[0]) readVttFile(e.target.files[0], 'baseline');
          e.target.value = '';
        }} />

      {(manualVtt?.adaptive || manualVtt?.baseline) && (
        <div style={{ marginTop: '16px', textAlign: 'center' }}>
          <button className="btn btn-ghost" style={{ fontSize: '0.85rem' }} onClick={applyManualVtts}>
            ▶ Load in Player
          </button>
        </div>
      )}

      {/* ── Job progress ── */}
      {jobId && jobStatus !== 'done' && (
        <div className="upload-progress">
          <div className="upload-progress-steps">
            {STEPS.map((s, i) => (
              <div key={s} className={`upload-step${i <= stepIndex ? ' upload-step--done' : ''}${i === stepIndex && s !== 'done' ? ' upload-step--active' : ''}`}>
                <div className="upload-step-dot">
                  {i < stepIndex ? <CheckIcon /> : i === stepIndex && s !== 'done' ? <span className="upload-spinner" /> : null}
                </div>
                <span>{s === 'queued' ? 'Queued' : s === 'processing' ? 'Processing' : 'Done'}</span>
              </div>
            ))}
          </div>
          <p className="upload-progress-msg">{jobMessage}</p>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="upload-error">
          <AlertIcon /> {error}
        </div>
      )}
    </div>
  );
}
