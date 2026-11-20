// ═══════════════════════════════════════════════════════════
// VideoPlayer.jsx — Custom video player (ported from app.js)
//
// 📚 LEARNING NOTE — useRef
//   In plain JS you'd write: const video = document.getElementById('video-player')
//   In React you use useRef() instead.
//   ref.current gives you the actual DOM element, just like getElementById.
//   WHY? Because React controls the DOM — you shouldn't query it yourself.
//   useRef lets React hand you a stable reference to the element.
//
// 📚 LEARNING NOTE — useEffect for event listeners
//   In plain JS you'd write: video.addEventListener('timeupdate', fn)
//   In React you put that inside useEffect so:
//     1. It runs AFTER the element is added to the DOM
//     2. You can return a cleanup function to removeEventListener
//        when the component unmounts (avoids memory leaks)
//
// 📚 LEARNING NOTE — useState for player state
//   Things that change the UI (playing, muted, volume, currentTime)
//   must live in useState so React knows to re-render.
//   Things that DON'T affect the UI (event handler refs, scrubbing
//   flags) can stay in useRef — no re-render needed.
// ═══════════════════════════════════════════════════════════

import { useRef, useState, useEffect, useCallback } from 'react';
import './VideoPlayer.css';

// ── REGION POSITIONING MAP (ported directly from app.js) ──
// Each region key maps to CSS values applied to absolutely-
// positioned cue <div>s inside the subtitle layer.
const REGION_STYLES = {
  bottom_center: { bottom: '0%',  left: '50%',  transform: 'translateX(-50%)', textAlign: 'center', maxWidth: '50%' },
  bottom_left:   { bottom: '0%',  left: '0%',   transform: 'none',             textAlign: 'left',   maxWidth: '35%' },
  bottom_right:  { bottom: '0%',  right: '0%',  transform: 'none',             textAlign: 'right',  maxWidth: '35%' },
  middle_left:   { top: '65%',    left: '0%',   transform: 'none',             textAlign: 'left',   maxWidth: '45%' },
  middle_right:  { top: '65%',    right: '0%',  transform: 'none',             textAlign: 'right',  maxWidth: '45%' },
  upper_left:    { top: '50%',    left: '0%',   transform: 'none',             textAlign: 'left',   maxWidth: '45%' },
  upper_right:   { top: '50%',    right: '0%',  transform: 'none',             textAlign: 'right',  maxWidth: '45%' },
  top_center:    { top: '25%',    left: '50%',  transform: 'translateX(-50%)', textAlign: 'center', maxWidth: '70%' },
};
const FALLBACK_REGION = 'bottom_center';

// Debug areas for the region overlay visualization
const REGION_DEBUG_AREAS = {
  bottom_center: { x: [0.25, 0.75], y: [0.85, 1.00] },
  bottom_left:   { x: [0.00, 0.35], y: [0.85, 1.00] },
  bottom_right:  { x: [0.65, 1.00], y: [0.85, 1.00] },
  middle_left:   { x: [0.00, 0.45], y: [0.65, 0.82] },
  middle_right:  { x: [0.55, 1.00], y: [0.65, 0.82] },
  upper_left:    { x: [0.00, 0.45], y: [0.50, 0.65] },
  upper_right:   { x: [0.55, 1.00], y: [0.50, 0.65] },
  top_center:    { x: [0.15, 0.85], y: [0.25, 0.40] },
};

// ── VTT / SRT PARSER (ported from app.js) ─────────────────
function parseVTTTime(timeStr) {
  const parts = timeStr.trim().replace(',', '.').split(':');
  let seconds = 0;
  if (parts.length === 3) {
    seconds += parseInt(parts[0], 10) * 3600;
    seconds += parseInt(parts[1], 10) * 60;
    seconds += parseFloat(parts[2]);
  } else if (parts.length === 2) {
    seconds += parseInt(parts[0], 10) * 60;
    seconds += parseFloat(parts[1]);
  }
  return seconds;
}

function parseVTT(vttText) {
  const lines = vttText.replace(/\r\n/g, '\n').split('\n');
  const cues = [];
  let i = 0;
  const isTimestamp = (l) => l.includes('-->') && /^[\d]/.test(l.trim());

  // Skip header (WEBVTT line, NOTE blocks, STYLE blocks)
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l === 'STYLE') {
      i++;
      while (i < lines.length && lines[i].trim() !== '}') i++;
      i++;
      continue;
    }
    if (l.startsWith('NOTE')) {
      i++;
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }
    if (isTimestamp(lines[i])) break;
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') { i++; continue; }

    // Skip cue ID line
    if (!isTimestamp(lines[i]) && i + 1 < lines.length && isTimestamp(lines[i + 1])) i++;

    const timeLine = lines[i];
    if (!timeLine || !isTimestamp(timeLine)) { i++; continue; }

    const arrowIdx = timeLine.indexOf('-->');
    const startStr = timeLine.slice(0, arrowIdx).trim();
    const afterArrow = timeLine.slice(arrowIdx + 3).trim();
    const spaceIdx = afterArrow.indexOf(' ');
    const endStr   = spaceIdx === -1 ? afterArrow : afterArrow.slice(0, spaceIdx);
    const settings = spaceIdx === -1 ? '' : afterArrow.slice(spaceIdx + 1);

    const start = parseVTTTime(startStr);
    const end   = parseVTTTime(endStr);

    const regionMatch = settings.match(/\bregion:(\S+)/);
    const region = (regionMatch && REGION_STYLES[regionMatch[1]])
      ? regionMatch[1]
      : FALLBACK_REGION;

    i++;
    let text = '';
    while (i < lines.length && lines[i].trim() !== '') {
      const cleanLine = lines[i].replace(/<[^>]+>/g, '').trim();
      if (cleanLine) text += (text ? '\n' : '') + cleanLine;
      i++;
    }

    if (text) cues.push({ start, end, text, region });
  }
  return cues;
}

// ── FORMAT TIME HELPER ─────────────────────────────────────
function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ── SVG ICONS ──────────────────────────────────────────────
const PlayIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
);
const PauseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
);
const VolumeHighIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
  </svg>
);
const VolumeLowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
  </svg>
);
const VolumeMuteIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
  </svg>
);
const CaptionIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="2" y="7" width="20" height="15" rx="2"/><path d="M7 13h4m0 0h2m-2 0v4m-4 0h4"/>
  </svg>
);
const GridIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
    <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
  </svg>
);
const ExpandIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polyline points="15,3 21,3 21,9"/><polyline points="9,21 3,21 3,15"/>
    <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
  </svg>
);
const CompressIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <polyline points="4,14 10,14 10,20"/><polyline points="20,10 14,10 14,4"/>
    <line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>
  </svg>
);
const SettingsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);
const VideoIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="7" width="15" height="13" rx="2"/>
    <path d="M17 9l5-3v12l-5-3V9z"/>
  </svg>
);

// ═══════════════════════════════════════════════════════════
// VideoPlayer Component
//
// Props:
//   videoSrc   (string) — URL or blob: URL of the video
//   baselineVtt (string|null) — text content of the baseline VTT
//   adaptiveVtt (string|null) — text content of the adaptive VTT
//
// These props are passed in from the parent (UploadPanel / DemoGallery).
// When the parent updates these, this component re-renders.
// ═══════════════════════════════════════════════════════════
function VideoPlayer({ videoSrc, baselineVtt, adaptiveVtt, isShowcase = false, onPlayStateChange }) {
  // ── Refs: direct DOM element access ─────────────────────
  // 📚 useRef() returns { current: null } initially.
  // When React renders <video ref={videoRef}>, it sets videoRef.current
  // to the actual DOM <video> element. After that, videoRef.current
  // works exactly like document.getElementById('video-player') did.
  const videoRef          = useRef(null);
  const containerRef      = useRef(null);
  const subtitleLayerRef  = useRef(null);
  const debugLayerRef     = useRef(null);
  const progressContRef   = useRef(null);
  const progressBarRef    = useRef(null);
  const progressBufferRef = useRef(null);
  const volumeSliderRef   = useRef(null);

  // Scrubbing state in refs (not useState) — changing these
  // should NOT trigger a re-render, just affect the next event.
  const isScrubbing         = useRef(false);
  const wasPlayingBeforeScrub = useRef(false);
  const lastScrubTime       = useRef(0);
  const scrubStartTime      = useRef(0);
  const scrubResumeTimer    = useRef(null);
  const idleTimeout         = useRef(null);

  // Parsed cues for the currently active VTT — also a ref because
  // updateSubtitles is called from timeupdate (60fps), and we don't
  // want a re-render just because we're reading the cue list.
  const parsedCuesRef = useRef([]);

  // ── State: things that change the visible UI ─────────────
  // 📚 Each useState triggers a re-render of the JSX below
  // when its setter is called.
  const [isPlaying,    setIsPlaying]    = useState(false);

  useEffect(() => {
    if (onPlayStateChange) onPlayStateChange(isShowcase ? false : isPlaying);
  }, [isPlaying, isShowcase, onPlayStateChange]);
  const [isMuted,      setIsMuted]      = useState(false);
  const [volume,       setVolume]       = useState(1);
  const [currentTime,  setCurrentTime]  = useState(0);
  const [duration,     setDuration]     = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showRegions,  setShowRegions]  = useState(false);
  const [subtitlesOn,  setSubtitlesOn]  = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeVtt,    setActiveVtt]    = useState('adaptive'); // 'adaptive' | 'baseline'
  const [captionSize,  setCaptionSize]  = useState('default');  // 'default' | 'large' | 'xlarge'
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(null);

  // Caption size → font-size mapping
  const CAPTION_SIZES = {
    default: { label: 'Default', fontSize: '1.1rem' },
    large:   { label: 'Large',   fontSize: '1.45rem' },
    xlarge:  { label: 'X-Large', fontSize: '1.85rem' },
  };

  // Close settings panel on outside click
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);

  // ── Helper: update the subtitle layer DOM directly ───────
  // We do this imperatively (direct DOM writes) inside a useRef
  // because it runs up to 60x per second — running setState that
  // often would cause too many re-renders and hurt performance.
  const updateSubtitles = useCallback((time) => {
    const layer = subtitleLayerRef.current;
    if (!layer) return;
    layer.innerHTML = '';

    if (!subtitlesOn || parsedCuesRef.current.length === 0) return;

    const activeCues = parsedCuesRef.current.filter(
      c => time >= c.start && time <= c.end
    );

    // Read caption size from a data attribute on the layer (avoids stale closure)
    const sizeKey = layer.dataset.captionSize || 'default';
    const SIZES = { default: '1.1rem', large: '1.45rem', xlarge: '1.85rem' };
    const cueFontSize = SIZES[sizeKey] || SIZES.default;

    activeCues.forEach(cue => {
      const style = REGION_STYLES[cue.region] || REGION_STYLES[FALLBACK_REGION];
      const box = document.createElement('div');
      box.className = 'cue-box';
      box.style.textAlign = style.textAlign;
      box.style.maxWidth  = style.maxWidth;
      if (style.top       !== undefined) box.style.top       = style.top;
      if (style.bottom    !== undefined) box.style.bottom    = style.bottom;
      if (style.left      !== undefined) box.style.left      = style.left;
      if (style.right     !== undefined) box.style.right     = style.right;
      if (style.transform)               box.style.transform = style.transform;

      cue.text.split('\n').forEach((lineText, idx) => {
        if (idx > 0) box.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.className = 'cue-line';
        span.style.fontSize = cueFontSize;
        span.textContent = lineText;
        box.appendChild(span);
      });

      layer.appendChild(box);
    });
  }, [subtitlesOn]);

  // ── Helper: update progress bar DOM directly ─────────────
  // Same reasoning — called every animation frame, keep it fast.
  const updateProgress = useCallback((time) => {
    const vid = videoRef.current;
    const bar = progressBarRef.current;
    if (!vid || !bar || !Number.isFinite(vid.duration) || vid.duration <= 0) return;
    const pct = Math.max(0, Math.min(100, (time / vid.duration) * 100));
    bar.style.width = `${pct}%`;
  }, []);

  // ── Effect: reset playback state when video source changes ──
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    if (progressBarRef.current) progressBarRef.current.style.width = '0%';
  }, [videoSrc]);

  // ── Effect: wire up all video event listeners ────────────
  // 📚 This is the React equivalent of the DOMContentLoaded block
  // in your old app.js. It runs once after the first render
  // (because the dependency array [] is empty).
  // The returned function is the "cleanup" — called when the
  // component is removed from the page to avoid memory leaks.
  useEffect(() => {
    const vid = videoRef.current;
    const container = containerRef.current;
    if (!vid || !container) return;

    // play / pause
    const onPlay  = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEmptied = () => setIsPlaying(false);

    // metadata loaded → know the duration
    const onLoadedMetadata = () => {
      setDuration(vid.duration);
      setIsPlaying(!vid.paused);
      updateProgress(vid.currentTime);
      updateSubtitles(vid.currentTime);
    };

    // main time update — runs up to 60 fps
    const onTimeUpdate = () => {
      if (!isScrubbing.current) {
        updateProgress(vid.currentTime);
        setCurrentTime(vid.currentTime);
      }
      updateSubtitles(vid.currentTime);
    };

    // buffer progress
    const onProgress = () => {
      const buf = progressBufferRef.current;
      if (!buf || !vid.buffered.length || !vid.duration) return;
      const bufferedEnd = vid.buffered.end(vid.buffered.length - 1);
      buf.style.width = `${(bufferedEnd / vid.duration) * 100}%`;
    };

    const onSeeked = () => updateSubtitles(vid.currentTime);

    // fullscreen change
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);

    vid.addEventListener('play',            onPlay);
    vid.addEventListener('pause',           onPause);
    vid.addEventListener('emptied',         onEmptied);
    vid.addEventListener('loadedmetadata',  onLoadedMetadata);
    vid.addEventListener('timeupdate',      onTimeUpdate);
    vid.addEventListener('progress',        onProgress);
    vid.addEventListener('seeked',          onSeeked);
    document.addEventListener('fullscreenchange', onFsChange);

    // Cleanup — remove all listeners when component unmounts
    return () => {
      vid.removeEventListener('play',           onPlay);
      vid.removeEventListener('pause',          onPause);
      vid.removeEventListener('emptied',        onEmptied);
      vid.removeEventListener('loadedmetadata', onLoadedMetadata);
      vid.removeEventListener('timeupdate',     onTimeUpdate);
      vid.removeEventListener('progress',       onProgress);
      vid.removeEventListener('seeked',         onSeeked);
      document.removeEventListener('fullscreenchange', onFsChange);
    };
  }, [updateProgress, updateSubtitles, videoSrc]);

  // ── Effect: keyboard shortcuts ───────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (isShowcase) return;
      if (document.activeElement?.tagName === 'INPUT') return;
      const vid = videoRef.current;
      if (!vid) return;
      switch (e.code) {
        case 'Space': case 'KeyK':
          e.preventDefault();
          vid.paused ? vid.play() : vid.pause();
          break;
        case 'ArrowRight':
          e.preventDefault(); vid.currentTime += 5; break;
        case 'ArrowLeft':
          e.preventDefault(); vid.currentTime -= 5; break;
        case 'KeyF':
          e.preventDefault(); toggleFullscreen(); break;
        case 'KeyM':
          e.preventDefault(); toggleMute(); break;
        case 'KeyC':
          e.preventDefault(); setSubtitlesOn(prev => !prev); break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [videoSrc, isShowcase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect: re-parse VTT when source or active track changes ──
  // 📚 [activeVtt, baselineVtt, adaptiveVtt] as the deps array means:
  // "run this effect whenever any of these three values changes".
  useEffect(() => {
    const text = activeVtt === 'adaptive' ? adaptiveVtt : baselineVtt;
    if (text) {
      parsedCuesRef.current = parseVTT(text);
    } else {
      parsedCuesRef.current = [];
    }
    updateSubtitles(videoRef.current?.currentTime ?? 0);
  }, [activeVtt, baselineVtt, adaptiveVtt, updateSubtitles]);

  // ── Effect: re-run subtitle rendering when subtitlesOn toggles ──
  useEffect(() => {
    updateSubtitles(videoRef.current?.currentTime ?? 0);
  }, [subtitlesOn, updateSubtitles]);

  // ── Effect: draw region debug boxes ─────────────────────
  useEffect(() => {
    const layer = debugLayerRef.current;
    if (!layer) return;
    layer.innerHTML = '';
    Object.entries(REGION_DEBUG_AREAS).forEach(([region, area]) => {
      const box = document.createElement('div');
      box.className = 'region-debug-box';
      box.dataset.region = region;
      box.style.left   = `${area.x[0] * 100}%`;
      box.style.top    = `${area.y[0] * 100}%`;
      box.style.width  = `${(area.x[1] - area.x[0]) * 100}%`;
      box.style.height = `${(area.y[1] - area.y[0]) * 100}%`;
      const label = document.createElement('div');
      label.className = 'region-debug-label';
      label.textContent = region.replace('_', ' ');
      box.appendChild(label);
      layer.appendChild(box);
    });
  }, []);

  // ── Effect: idle cursor hide ─────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const hideControls = () => {
      if (!videoRef.current?.paused) container.classList.add('idle');
    };
    const resetIdle = () => {
      container.classList.remove('idle');
      clearTimeout(idleTimeout.current);
      idleTimeout.current = setTimeout(hideControls, 3000);
    };
    container.addEventListener('mousemove',  resetIdle);
    container.addEventListener('mousedown',  resetIdle);
    container.addEventListener('touchstart', resetIdle);
    container.addEventListener('mouseleave', () => {
      if (!videoRef.current?.paused) hideControls();
    });
    return () => {
      clearTimeout(idleTimeout.current);
    };
  }, []);

  // ── Playback controls ────────────────────────────────────
  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.paused ? vid.play() : vid.pause();
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = !vid.muted;
    setIsMuted(vid.muted);
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    const vid = videoRef.current;
    if (!vid) return;
    vid.volume = val;
    vid.muted  = val === 0;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const handleSpeedChange = (speed) => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.playbackRate = speed;
    setPlaybackRate(speed);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen();
    }
  };

  // ── Seek / scrub ─────────────────────────────────────────
  const getSeekTime = (clientX) => {
    const rect = progressContRef.current?.getBoundingClientRect();
    const vid = videoRef.current;
    if (!rect || !vid || !Number.isFinite(vid.duration)) return 0;
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pos * vid.duration;
  };

  const commitScrub = (shouldResume) => {
    const vid = videoRef.current;
    const scrubTime = Math.max(0, Math.min(vid?.duration ?? 0, lastScrubTime.current));
    updateProgress(scrubTime);
    updateSubtitles(scrubTime);
    if (vid) vid.currentTime = scrubTime;
    if (!shouldResume) return;
    const resume = () => vid.play().catch(console.error);
    if (vid?.seeking) {
      vid.addEventListener('seeked', resume, { once: true });
      scrubResumeTimer.current = setTimeout(resume, 250);
    } else {
      resume();
    }
  };

  const onProgressPointerDown = (e) => {
    const vid = videoRef.current;
    if (!vid || !Number.isFinite(vid.duration)) return;
    e.preventDefault();
    wasPlayingBeforeScrub.current = !vid.paused && !vid.ended;
    scrubStartTime.current = vid.currentTime;
    lastScrubTime.current  = vid.currentTime;
    vid.pause();
    isScrubbing.current = true;
    progressContRef.current?.classList.add('scrubbing');
    progressContRef.current?.setPointerCapture(e.pointerId);
    const scrubTime = getSeekTime(e.clientX);
    lastScrubTime.current = scrubTime;
    updateProgress(scrubTime);
    updateSubtitles(scrubTime);
  };

  const onProgressPointerMove = (e) => {
    if (!isScrubbing.current) return;
    e.preventDefault();
    const scrubTime = getSeekTime(e.clientX);
    lastScrubTime.current = scrubTime;
    updateProgress(scrubTime);
    updateSubtitles(scrubTime);
  };

  const onProgressPointerUp = (e) => {
    if (!isScrubbing.current) return;
    const shouldResume = wasPlayingBeforeScrub.current;
    isScrubbing.current = false;
    wasPlayingBeforeScrub.current = false;
    progressContRef.current?.classList.remove('scrubbing');
    if (progressContRef.current?.hasPointerCapture(e.pointerId)) {
      progressContRef.current.releasePointerCapture(e.pointerId);
    }
    commitScrub(shouldResume);
  };

  // Volume icon helper
  const VolumeIcon = isMuted || volume === 0
    ? VolumeMuteIcon
    : volume < 0.5
    ? VolumeLowIcon
    : VolumeHighIcon;

  // Has any VTT been provided?
  const hasVtt = !!(baselineVtt || adaptiveVtt);

  // ── JSX ───────────────────────────────────────────────────
  // 📚 Note: everything in curly braces {} inside JSX is a
  // JavaScript expression. Booleans, conditions, and maps all
  // go inside {}.
  return (
    <div>
      {/* Video container — shown only when a video source is set */}
      {videoSrc ? (
        <div
          ref={containerRef}
          className={`video-container ${isPlaying ? 'playing' : 'paused'} ${showRegions ? 'show-regions' : ''} ${isShowcase ? 'showcase' : ''}`}
          id="video-container"
        >
          {/* 📚 ref={videoRef} → React sets videoRef.current to this element */}
          <video
            ref={videoRef}
            src={videoSrc}
            id="video-player"
            playsInline
            autoPlay={isShowcase}
            muted={isShowcase}
            loop={isShowcase}
            tabIndex={isShowcase ? -1 : undefined}
            aria-hidden={isShowcase || undefined}
          />

          {isShowcase && (
            <p className="showcase-note">AI-generated video · For demonstration purposes only</p>
          )}

          {/* Subtitle overlay — data-caption-size used by imperative updateSubtitles */}
          <div ref={subtitleLayerRef} className="subtitle-layer" id="subtitle-layer"
               data-caption-size={captionSize} />

          {/* Region debug overlay */}
          <div ref={debugLayerRef} className="region-debug-layer" id="region-debug-layer" aria-hidden="true" />

          {/* Click to play/pause */}
          <div className="video-overlay" onClick={togglePlay} aria-hidden="true">
            <div className="big-play-button">
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </div>
          </div>

          {/* Control bar */}
          <div className="controls-container" id="controls">
            {/* Progress / seek bar */}
            <div
              ref={progressContRef}
              className="progress-container"
              id="progress-container"
              onPointerDown={onProgressPointerDown}
              onPointerMove={onProgressPointerMove}
              onPointerUp={onProgressPointerUp}
              onPointerCancel={onProgressPointerUp}
              role="slider"
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
            >
              <div ref={progressBufferRef} className="progress-buffer" id="progress-buffer" />
              <div ref={progressBarRef}    className="progress-bar"    id="progress-bar" />
            </div>

            <div className="controls-main">
              {/* Left controls */}
              <div className="controls-left">
                <button className="control-btn" onClick={togglePlay}
                  id="play-pause-btn" aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>

                <div className="volume-container">
                  <button className="control-btn" onClick={toggleMute}
                    id="mute-btn" aria-label={isMuted ? 'Unmute' : 'Mute'}>
                    <VolumeIcon />
                  </button>
                  <input
                    ref={volumeSliderRef}
                    type="range"
                    className="volume-slider"
                    id="volume-slider"
                    min="0" max="1" step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    aria-label="Volume"
                  />
                </div>

                <div className="time-display" aria-live="off">
                  <span id="current-time">{formatTime(currentTime)}</span>
                  {' / '}
                  <span id="duration">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Right controls */}
              <div className="controls-right">
                {/* VTT source switch */}
                {hasVtt && (
                  <div className="vtt-switch footer-vtt-switch" role="group" aria-label="Subtitle source">
                    <button
                      className={`vtt-pill ${activeVtt === 'adaptive' ? 'active' : ''}`}
                      onClick={() => setActiveVtt('adaptive')}
                      disabled={!adaptiveVtt}
                      id="vtt-adaptive-btn"
                    >
                      ★ Adaptive
                    </button>
                    <button
                      className={`vtt-pill ${activeVtt === 'baseline' ? 'active' : ''}`}
                      onClick={() => setActiveVtt('baseline')}
                      disabled={!baselineVtt}
                      id="vtt-baseline-btn"
                    >
                      Baseline
                    </button>
                  </div>
                )}

                {/* Region debug toggle */}
                <button
                  className={`control-btn ${showRegions ? 'active' : ''}`}
                  onClick={() => setShowRegions(prev => !prev)}
                  id="region-debug-btn"
                  aria-label="Toggle region overlay"
                  title="Show Scoring Regions"
                >
                  <GridIcon />
                </button>

                {/* Subtitle toggle */}
                <button
                  className={`control-btn ${subtitlesOn && hasVtt ? 'active' : ''}`}
                  onClick={() => setSubtitlesOn(prev => !prev)}
                  id="caption-btn"
                  aria-label="Toggle subtitles"
                  title="Toggle Subtitles (C)"
                >
                  <CaptionIcon />
                </button>

                {/* ⚙ Settings panel (speed + caption size) */}
                <div className="settings-container" ref={settingsRef}>
                  <button
                    className={`control-btn settings-btn ${showSettings ? 'active' : ''}`}
                    id="settings-btn"
                    aria-label="Player settings"
                    title="Settings"
                    onClick={() => setShowSettings(prev => !prev)}
                  >
                    <SettingsIcon />
                  </button>

                  {showSettings && (
                    <div className="settings-panel" role="dialog" aria-label="Player settings">

                      {/* ── Playback Speed slider ── */}
                      <div className="settings-section">
                        <div className="settings-section-header">
                          <span className="settings-section-title">Playback Speed</span>
                          <span className="settings-section-value">{playbackRate}×</span>
                        </div>
                        <input
                          type="range"
                          className="settings-slider"
                          min="0.25" max="2" step="0.25"
                          value={playbackRate}
                          onChange={e => handleSpeedChange(parseFloat(e.target.value))}
                          aria-label="Playback speed"
                        />
                        <div className="settings-slider-ticks">
                          <span>0.25×</span><span>1×</span><span>2×</span>
                        </div>
                      </div>

                      {/* ── Caption Size slider ── */}
                      <div className="settings-section">
                        <div className="settings-section-header">
                          <span className="settings-section-title">Caption Size</span>
                          <span className="settings-section-value">{CAPTION_SIZES[captionSize].label}</span>
                        </div>
                        <input
                          type="range"
                          className="settings-slider"
                          min="0" max="2" step="1"
                          value={['default','large','xlarge'].indexOf(captionSize)}
                          onChange={e => {
                            const key = ['default','large','xlarge'][parseInt(e.target.value)];
                            setCaptionSize(key);
                            if (subtitleLayerRef.current)
                              subtitleLayerRef.current.dataset.captionSize = key;
                            updateSubtitles(videoRef.current?.currentTime ?? 0);
                          }}
                          aria-label="Caption size"
                        />
                        <div className="settings-slider-ticks">
                          <span>Default</span><span>Large</span><span>X-Large</span>
                        </div>
                      </div>

                    </div>
                  )}
                </div>

                {/* Fullscreen */}
                <button className="control-btn" onClick={toggleFullscreen}
                  id="fullscreen-btn" aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
                  {isFullscreen ? <CompressIcon /> : <ExpandIcon />}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Empty state — shown before any video is loaded */
        <div className="player-empty" id="player-empty">
          <div className="player-empty-icon"><VideoIcon /></div>
          <p>No video loaded yet</p>
          <p style={{ fontSize: '0.85rem' }}>Upload a video above or pick a demo below</p>
        </div>
      )}
    </div>
  );
}

export default VideoPlayer;
