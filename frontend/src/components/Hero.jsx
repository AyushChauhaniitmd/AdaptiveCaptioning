// ═══════════════════════════════════════════════════════════
// Hero.jsx — Landing page hero section
//
// 📚 LEARNING NOTE:
//   JSX looks like HTML, but it's actually JavaScript.
//   Rules that differ from plain HTML:
//     - Use className instead of class (class is a JS keyword)
//     - All tags must be closed: <br /> not <br>
//     - Events use camelCase: onClick, onMouseEnter etc.
//     - { } inside JSX runs JavaScript expressions
// ═══════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import './Hero.css';

const PIPELINE_SOURCE_URL = 'http://localhost:8001/pipeline.py';

const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'True', 'try', 'while', 'with', 'yield',
]);
const PYTHON_BUILTINS = new Set([
  'abs', 'bool', 'dict', 'enumerate', 'float', 'int', 'len', 'list', 'max', 'min',
  'open', 'print', 'range', 'set', 'str', 'sum', 'tuple', 'zip',
]);
const PYTHON_TOKEN_PATTERN = /(#.*$|\"\"\"[\s\S]*?\"\"\"|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b|\b(?:abs|bool|dict|enumerate|float|int|len|list|max|min|open|print|range|set|str|sum|tuple|zip)\b|\b\d+(?:\.\d+)?\b)/gm;
const PIPELINE_SECTIONS = [
  { start: 1,    title: 'Setup & imports',      description: 'Loads CV, OCR, subtitle, and data tools; imports argparse, cv2, easyocr, numpy, pysrt, torch.' },
  { start: 39,   title: 'Regions & weights',    description: 'Defines 8 safe caption zones (bottom_center → top_center) and the OCR/edge/writing score weights.' },
  { start: 98,   title: 'Folders & metadata',   description: 'Creates output directories and reads video metadata from master.csv.' },
  { start: 125,  title: 'OCR detector',          description: 'Initializes the EasyOCR reader on GPU (CUDA) or CPU.' },
  { start: 136,  title: 'Frame extraction',      description: 'Extracts, resizes to 640×360, and sequentially decodes frames via a single ffmpeg process.' },
  { start: 209,  title: 'FrameStream (ffmpeg)',  description: 'Sequential BGR frame reader backed by one ffmpeg process — avoids repeated expensive seeks.' },
  { start: 327,  title: 'Similarity check',      description: 'Two-stage check (histogram + pixel MAD + structural diff) to skip unchanged frames.' },
  { start: 371,  title: 'Region masks',          description: 'Builds pixel-accurate boolean masks for each of the 8 subtitle placement regions.' },
  { start: 392,  title: 'Visual features',       description: 'Computes Canny edge density and batched EasyOCR text-area overlap for all regions in one call.' },
  { start: 523,  title: 'Active writing',        description: 'Detects persistent ink/chalk accumulation per region using frame diffs against the subtitle-start reference frame.' },
  { start: 668,  title: 'Region scoring',        description: 'Scores every region: base + OCR×5 + edge×4 + writing×3. OCR suppresses edge when text is present.' },
  { start: 726,  title: 'Frame aggregation',     description: 'Samples 3 frames per subtitle, runs writing detection once, then MAX-aggregates per-region scores.' },
  { start: 802,  title: 'Temporal smoothing',    description: 'Hysteresis (−0.15 discount on current region) + 0.5 s dwell timer prevent distracting caption jumps.' },
  { start: 883,  title: 'Subtitle formatting',   description: 'Normalizes line breaks, wraps text to per-region character budgets (27–53 chars), builds VTT cues.' },
  { start: 956,  title: 'VTT helpers',           description: 'Builds the WebVTT string with inline line/position fallbacks and region: tags for the JS renderer.' },
  { start: 1041, title: 'Metrics',               description: 'Computes switch rate, avg dwell, region distribution %, and displacement score; appends to summary.csv.' },
  { start: 1085, title: 'Debug logging',         description: 'Captures per-subtitle diagnostics (scores, flags, text before/after wrap) into a CSV for evaluation.' },
  { start: 1120, title: 'Main pipeline',         description: 'Orchestrates the full run: ffprobe offset → NVDEC-accelerated FrameStream → per-subtitle scoring → VTT + metrics output.' },
  { start: 1343, title: 'Command-line entry',    description: 'argparse CLI: --video, --video-path, --subtitle-path, --output-dir, --mode, --transition, --debug.' },
];

function highlightPython(source) {
  return source.split(PYTHON_TOKEN_PATTERN).filter(token => token !== undefined).map((token, index) => {
    let className = '';
    if (token.startsWith('#')) className = 'syntax-comment';
    else if (token.startsWith('"') || token.startsWith("'")) className = 'syntax-string';
    else if (PYTHON_KEYWORDS.has(token)) className = 'syntax-keyword';
    else if (PYTHON_BUILTINS.has(token)) className = 'syntax-builtin';
    else if (/^\d/.test(token)) className = 'syntax-number';

    return className ? <span className={className} key={index}>{token}</span> : token;
  });
}

// Inline SVG icons
const ArrowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12"/>
    <polyline points="12,5 19,12 12,19"/>
  </svg>
);

// ── Hero Component ─────────────────────────────────────────
// Props: onTryDemo — callback to scroll down to the demo section
function Hero({ onTryDemo }) {
  const [pipelineSource, setPipelineSource] = useState('Loading pipeline.py...');
  const [activePipelineSection, setActivePipelineSection] = useState(PIPELINE_SECTIONS[0]);
  const highlightedPipeline = useMemo(() => highlightPython(pipelineSource), [pipelineSource]);
  const pipelineLineCount = useMemo(() => pipelineSource.split('\n').length, [pipelineSource]);

  useEffect(() => {
    let cancelled = false;

    fetch(PIPELINE_SOURCE_URL)
      .then(response => {
        if (!response.ok) throw new Error('Could not load pipeline.py');
        return response.text();
      })
      .then(source => {
        if (!cancelled) setPipelineSource(source);
      })
      .catch(() => {
        if (!cancelled) {
          setPipelineSource('# pipeline.py\n# Source preview is unavailable. Start the local demo server on port 8001.');
        }
      });

    return () => { cancelled = true; };
  }, []);

  const scrollToUpload = () => {
    document.getElementById('upload')?.scrollIntoView({ behavior: 'smooth' });
  };

  const handlePipelineScroll = (event) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const scrollableHeight = Math.max(scrollHeight - clientHeight, 1);
    const currentLine = Math.round((scrollTop / scrollableHeight) * (pipelineLineCount - 1)) + 1;
    const nextSection = PIPELINE_SECTIONS.reduce(
      (current, section) => (section.start <= currentLine ? section : current),
      PIPELINE_SECTIONS[0],
    );

    setActivePipelineSection(current => current.start === nextSection.start ? current : nextSection);
  };

  return (
    <section className="hero" id="hero" aria-label="Hero section">
      <div className="hero-inner">

        {/* ── Left: Text content ── */}
        <div className="hero-content">


          <h1 className="hero-headline">
            <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
              Subtitles that{' '}
              <span className="hero-headline-accent">adapt</span>
            </span>
            <span style={{ display: 'block' }}>to your video</span>
          </h1>

          <p className="hero-description">
            An adaptive subtitle placement system that uses <strong>OCR</strong>, <strong>computer vision</strong>,
            and <strong>NVDEC</strong> GPU-accelerated frame decoding to intelligently position captions —
            avoiding text and important visual content in real time.
          </p>

          {/* ── Tech badge strip ── */}
          <div className="hero-tech-badges" aria-label="Technologies used">
            <span className="hero-tech-badge" title="EasyOCR detects on-screen text in each region">OCR</span>
            <span className="hero-tech-badge" title="Canny edge density + active ink detection via OpenCV">CV</span>
            <span className="hero-tech-badge hero-tech-badge--gpu" title="ffmpeg NVDEC decodes frames on the GPU — no repeated CPU seeks">
              NVDEC
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{marginLeft:'4px',opacity:0.8}}><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </span>

          </div>

          <div className="hero-actions">
            <button
              className="btn btn-primary"
              onClick={scrollToUpload}
              id="hero-try-btn"
              aria-label="Try it with your own video or view demo"
            >
              Try Your Video / View Demo <ArrowIcon />
            </button>
          </div>

          {/* Stats row */}
          <div className="hero-stats" aria-label="Project statistics">
            <div>
              <div className="hero-stat-value">3</div>
              <div className="hero-stat-label">Lecture types</div>
            </div>
            <div>
              <div className="hero-stat-value">8</div>
              <div className="hero-stat-label">Placement regions</div>
            </div>
            <div>
              <div className="hero-stat-value">OCR+CV</div>
              <div className="hero-stat-label">Frame analysis</div>
            </div>
            <div>
              <div className="hero-stat-value hero-stat-value--gpu">NVDEC</div>
              <div className="hero-stat-label">GPU decode</div>
            </div>
          </div>
        </div>

        <div className="hero-pipeline-preview">
          <p className="hero-code-kicker" aria-label="The algorithmic brain">
            The Algorithmic Brain
          </p>
          <aside className="hero-code-panel" aria-label="pipeline.py source code">
            <div className="hero-code-header">
              <div className="hero-code-dots" aria-hidden="true"><i /><i /><i /></div>
              <span>pipeline</span>
              <div className="hero-code-insight" role="status" aria-live="polite">
                <span>Now viewing · {activePipelineSection.title}</span>
                <p>{activePipelineSection.description}</p>
              </div>
            </div>
            <pre className="hero-code-content" onScroll={handlePipelineScroll}>
              <code>{highlightedPipeline}</code>
            </pre>
          </aside>
        </div>

      </div>
    </section>
  );
}

export default Hero;
