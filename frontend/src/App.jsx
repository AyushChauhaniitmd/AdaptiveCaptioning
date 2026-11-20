// ═══════════════════════════════════════════════════════════
// App.jsx — Root component
//
// 📚 LEARNING NOTE — useState hook
//   useState(initialValue) returns [value, setter].
//   When you call setter(newValue), React re-renders the
//   component with the new value. This is "reactive" — the
//   UI automatically stays in sync with your data.
//
// 📚 LEARNING NOTE — useEffect hook
//   useEffect(fn, [deps]) runs fn after render.
//   Used here to:
//     1. Detect prefers-color-scheme on first load
//     2. Apply the theme by writing data-theme on <html>
//   The [] means "run only once on mount" (like componentDidMount).
// ═══════════════════════════════════════════════════════════

import { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import VideoPlayer from './components/VideoPlayer';
import UploadPanel from './components/UploadPanel';
import About from './components/About';
import './index.css';
import './App.css';

const DEFAULT_VIDEO_SRC = 'http://localhost:8001/demo.mp4';

// ── Helper: detect OS/browser preferred color scheme ──────
function getPreferredTheme() {
  // Check if user previously chose a theme (stored in localStorage)
  const saved = localStorage.getItem('ac-theme');
  if (saved === 'dark' || saved === 'light') return saved;

  // Fall back to OS preference
  if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

// ── VTT → SRT converter ───────────────────────────────────
function vttToSrt(vttText) {
  if (!vttText) return '';
  const trimmed = vttText.trim();
  if (!trimmed.startsWith('WEBVTT') && /^\d+\s*[\r\n]+\d{2}:\d{2}:\d{2}/.test(trimmed)) {
    return trimmed;
  }
  const lines = vttText.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let cueIndex = 1;
  let i = 0;
  // skip header lines (WEBVTT, STYLE blocks, NOTE blocks)
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === 'STYLE') { i++; while (i < lines.length && lines[i].trim() !== '}') i++; i++; continue; }
    if (l.startsWith('NOTE')) { i++; while (i < lines.length && lines[i].trim() !== '') i++; continue; }
    if (l.includes('-->')) break;
    i++;
  }
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === '') { i++; continue; }
    // skip cue ID
    if (!l.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) i++;
    const timeLine = lines[i]?.trim();
    if (!timeLine?.includes('-->')) { i++; continue; }
    // VTT timestamps may have cue settings after the end time — strip them
    // and convert dots to commas: 00:00:01.234 → 00:00:01,234
    const [rawStart, rawRest] = timeLine.split('-->');
    const endAndSettings = rawRest.trim().split(' ');
    const start = rawStart.trim().replace('.', ',');
    const end   = endAndSettings[0].replace('.', ',');
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const clean = lines[i].replace(/<[^>]+>/g, '').trim();
      if (clean) textLines.push(clean);
      i++;
    }
    if (textLines.length) {
      out.push(`${cueIndex++}\n${start} --> ${end}\n${textLines.join('\n')}\n`);
    }
  }
  return out.join('\n');
}

// ── Extract filename stem without extension ──────────────
function getVideoStem(nameOrUrl) {
  if (!nameOrUrl) return 'video';
  const clean = nameOrUrl.split('?')[0].split('#')[0];
  const filename = clean.split('/').pop()?.split('\\').pop() || clean;
  const stem = filename.replace(/\.[^/.]+$/, '');
  return stem || 'video';
}

// ── App Component ─────────────────────────────────────────
function App() {
  // Theme state
  const [theme, setTheme] = useState(() => getPreferredTheme());

  // Player state — lives here so both UploadPanel and DemoGallery
  // can load videos into the same player (lifted state)
  const [videoSrc, setVideoSrc] = useState(DEFAULT_VIDEO_SRC);
  const [videoName, setVideoName] = useState(() => getVideoStem(DEFAULT_VIDEO_SRC));
  const [baselineVtt, setBaselineVtt] = useState(null);
  const [adaptiveVtt, setAdaptiveVtt] = useState(null);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);

  // Apply theme to <html> element whenever it changes
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ac-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  // ── Download subtitles as SRT ────────────────────────────
  const isSrtReady = Boolean(
    (adaptiveVtt && adaptiveVtt.trim().length > 0) ||
    (baselineVtt && baselineVtt.trim().length > 0)
  );

  const handleDownloadSrt = () => {
    const subtitleContent = adaptiveVtt || baselineVtt;
    if (!subtitleContent) return;
    const srt = vttToSrt(subtitleContent);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const filename = `${videoName || getVideoStem(videoSrc) || 'video'}.srt`;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ── Upload button toggle state ─────────────────────────────
  // Controls whether the header shows one button or two
  const [showUploadOptions, setShowUploadOptions] = useState(false);
  const [showGettingStartedHint, setShowGettingStartedHint] = useState(false);
  const [showDemos, setShowDemos] = useState(false);
  const [demoVideos, setDemoVideos] = useState([]);

  const handleSeeDemo = async () => {
    if (demoVideos.length > 0) {
      setShowDemos(!showDemos);
      return;
    }
    try {
      const r = await fetch('http://localhost:8001/player/manifest.json');
      const data = await r.json();
      setDemoVideos(data.videos || []);
      setShowDemos(true);
    } catch {
      alert("Could not reach demo server on port 8001.");
    }
  };

  const loadDemoVideo = async (videoPath) => {
    try {
      const manifest = await fetch('http://localhost:8001/player/manifest.json').then(r => r.json());
      const stem = videoPath.split('/').pop().replace(/\.mp4$/i, '');
      const adaptivePath = manifest.subtitles.adaptive.find(v => v.includes(stem));
      const baselinePath = manifest.subtitles.baseline.find(v => v.includes(stem));

      const [adaptiveText, baselineText] = await Promise.all([
        adaptivePath ? fetch(`http://localhost:8001/${adaptivePath}`).then(r => r.text()).catch(() => null) : null,
        baselinePath ? fetch(`http://localhost:8001/${baselinePath}`).then(r => r.text()).catch(() => null) : null,
      ]);

      handleVideoLoad(`http://localhost:8001/${videoPath}`, baselineText, adaptiveText, stem);
      setShowDemos(false);
    } catch (e) {
      alert("Error loading demo video: " + e.message);
    }
  };

  // ── Unified video loader ───────────────────────────────────
  const handleVideoLoad = (videoUrl, baselineVttText, adaptiveVttText, rawName) => {
    if (videoUrl && videoSrc?.startsWith('blob:') && videoSrc !== videoUrl) {
      URL.revokeObjectURL(videoSrc);
    }
    if (videoUrl) setVideoSrc(videoUrl);
    setBaselineVtt(baselineVttText);
    setAdaptiveVtt(adaptiveVttText);
    if (rawName || videoUrl) setVideoName(getVideoStem(rawName || videoUrl));
    setShowUploadOptions(false); // collapse back to single button once loaded
    if (videoUrl) {
      document.getElementById('video-player')?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="app">
      {!isVideoPlaying && <Navbar theme={theme} onThemeToggle={toggleTheme} />}

      <main>
        <Hero />

        {/* ── Upload + Player section ── */}
        <section id="upload" className="section">
          <div className="container">

            {/* Header row: title left, upload trigger(s) right */}
            <div className="section-header-row">
              <div>
                <p className="section-label">Try It</p>
                <h2 className="section-title">Upload &amp; Compare</h2>
              </div>

              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>

                {/* ── Download SRT button — appears ONLY when SRT/subtitles are ready ── */}
                {isSrtReady && (
                  <button
                    className="download-srt-btn"
                    onClick={handleDownloadSrt}
                    id="download-srt-btn"
                    title={`Download ${videoName || 'video'}.srt`}
                    aria-label={`Download ${videoName || 'video'}.srt`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                  </button>
                )}
                {videoSrc && videoSrc.startsWith('blob:') && (
                  <button
                    className="section-upload-trigger"
                    onClick={() => {
                      document.getElementById('hidden-generate-btn')?.click();
                    }}
                    id="generate-subtitles-btn"
                  >
                    Generate Subtitles
                  </button>
                )}

                <div
                  className="dropdown-container"
                  onMouseEnter={() => setShowGettingStartedHint(true)}
                  onMouseLeave={() => setShowGettingStartedHint(false)}
                >
                  <button
                    className="section-upload-trigger"
                    onClick={() => {
                      setShowUploadOptions(!showUploadOptions);
                      setShowGettingStartedHint(false);
                    }}
                    id="header-upload-btn"
                  >
                    Getting Started!
                  </button>

                  {/* ── Hover hint card on right side ── */}
                  {!showUploadOptions && (
                    <div
                      className={`getting-started-hint ${showGettingStartedHint ? 'visible' : ''}`}
                      role="tooltip"
                    >
                      <span className="hint-icon">💡</span>
                      <div className="hint-text">
                        Upload your video and an optional SRT file. Once loaded, click the <strong>Generate Subtitles</strong> button appearing beside to compute occlusion-free adaptive placements!
                      </div>
                    </div>
                  )}

                {showUploadOptions && (
                  <div className="dropdown-menu">
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setShowUploadOptions(false);
                        setShowDemos(false);
                        setTimeout(() => document.getElementById('up-video')?.click(), 0);
                      }}
                    >
                      Upload video
                    </button>
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setShowUploadOptions(false);
                        setShowDemos(false);
                        setTimeout(() => document.getElementById('up-baseline')?.click(), 0);
                      }}
                    >
                      Upload Baseline SRT
                    </button>
                    <button
                      className="dropdown-item"
                      onClick={handleSeeDemo}
                    >
                      See a demo video
                    </button>
                    {showDemos && demoVideos.map(v => (
                      <button key={v} className="dropdown-item" onClick={() => loadDemoVideo(v)}>
                        {v.split('/').pop().replace(/\.mp4$/i, '').replace(/_/g, ' ')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

            {/* ── Full UploadPanel ── */}
            <UploadPanel onVideoLoad={handleVideoLoad} />


            {/* VideoPlayer receives state as props */}
            <VideoPlayer
              videoSrc={videoSrc}
              baselineVtt={baselineVtt}
              adaptiveVtt={adaptiveVtt}
              isShowcase={videoSrc === DEFAULT_VIDEO_SRC}
              onPlayStateChange={setIsVideoPlaying}
            />
          </div>
        </section>



        <About />
      </main>

      <footer className="app-footer">
        <div className="container app-footer-inner">
          <div className="app-footer-logo">
            Adaptive<span>Captions</span>
          </div>
          <div className="app-footer-content">
            <p>
              AdaptiveCaptions is a free and open source <a href="https://github.com/AyushChauhaniitmd/AdaptiveCaptioning" target="_blank" rel="noopener noreferrer">intelligent subtitling tool.</a><br />
              Video analysis powered by OCR and computer vision
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
