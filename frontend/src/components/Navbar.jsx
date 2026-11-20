// ═══════════════════════════════════════════════════════════
// Navbar.jsx — Top navigation bar
//
// 📚 LEARNING NOTE:
//   This is a React "functional component" — just a plain
//   JavaScript function that returns JSX (HTML-like syntax).
//
//   Props: the "theme" and "onThemeToggle" values are passed
//   in from the parent (App.jsx) like HTML attributes:
//     <Navbar theme={theme} onThemeToggle={toggle} />
//
//   Hooks used: none here — state lives in App.jsx and
//   gets passed down as props. This is called "lifting state up".
// ═══════════════════════════════════════════════════════════

import './Navbar.css';

// SVG icons as inline components — no icon library needed
const SunIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5"/>
    <line x1="12" y1="1" x2="12" y2="3"/>
    <line x1="12" y1="21" x2="12" y2="23"/>
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
    <line x1="1" y1="12" x2="3" y2="12"/>
    <line x1="21" y1="12" x2="23" y2="12"/>
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
  </svg>
);

const MoonIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>
);

const GitHubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57
      0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695
      -.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99
      .105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225
      -.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405
      c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225
      0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3
      0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
  </svg>
);

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,3 19,12 5,21"/>
  </svg>
);

// ── The Component ─────────────────────────────────────────
// "props" is an object — we destructure it for cleaner code.
// { theme, onThemeToggle } means: give me theme and onThemeToggle
// from whatever was passed to <Navbar theme=... onThemeToggle=... />

function Navbar({ theme, onThemeToggle }) {
  // Smooth scroll helper — scrolls to a section by its id
  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <nav className="navbar" role="navigation" aria-label="Main navigation">
      <div className="navbar-inner">

        {/* Logo */}
        <a href="#" className="navbar-logo" aria-label="AdaptiveCaptions home">
          <div className="navbar-logo-icon" aria-hidden="true">
            <PlayIcon />
          </div>
          <div>Adaptive<span>Captions</span></div>
        </a>

        {/* Marquee text replacing old nav links */}
        <div className="navbar-marquee-container">
          <div className="navbar-marquee">
            Currently supporting .mp4 video and .vtt subtitle formats. Smart subtitle placement is designed exclusively for digital presentations without live human subjects.
          </div>
        </div>

        <div className="navbar-right">
          {/* 📚 Note: onClick calls onThemeToggle, which is defined in App.jsx.
              This is how child components communicate with parents — via callbacks. */}
          <button
            className="theme-toggle"
            onClick={onThemeToggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {/* Ternary: show Sun when dark, Moon when light */}
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>

      </div>
    </nav>
  );
}

// Every component must be exported so other files can import it
export default Navbar;
