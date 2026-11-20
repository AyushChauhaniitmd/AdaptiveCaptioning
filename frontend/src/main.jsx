// ═══════════════════════════════════════════════════════════
// main.jsx — The entry point of the entire React app
//
// 📚 LEARNING NOTE:
//   This is the first file that runs. It:
//     1. Imports React (needed for JSX transformation)
//     2. Imports ReactDOM (handles rendering to the real HTML DOM)
//     3. Finds the <div id="root"> in index.html
//     4. Mounts our <App /> component inside it
//
//   After this, React takes over. Every UI update happens
//   through React's virtual DOM — never via direct DOM manipulation
//   (except in special cases using useRef, which we'll see later).
// ═══════════════════════════════════════════════════════════

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// 📚 StrictMode: a development-only wrapper that helps catch bugs.
//   It intentionally renders components twice to surface side effects.
//   Has no effect in production builds.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
