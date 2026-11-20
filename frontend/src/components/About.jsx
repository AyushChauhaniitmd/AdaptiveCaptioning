import './About.css';

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

const ReportIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);

const MailIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <polyline points="22,6 12,13 2,6"/>
  </svg>
);

const LinkedinIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.23 0H1.77C.8 0 0 .77 0 1.72v20.56C0 23.23.8 24 1.77 24h20.46c.98 0 1.77-.77 1.77-1.72V1.72C24 .77 23.2 0 22.23 0zM7.12 20.45H3.56V9h3.56v11.45zM5.34 7.43c-1.14 0-2.06-.92-2.06-2.06 0-1.14.92-2.06 2.06-2.06 1.14 0 2.06.92 2.06 2.06 0 1.14-.92 2.06-2.06 2.06zm15.11 13.02h-3.56v-5.56c0-1.33-.03-3.03-1.85-3.03-1.85 0-2.13 1.45-2.13 2.94v5.65h-3.56V9h3.42v1.56h.05c.48-.9 1.63-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29z"/>
  </svg>
);

export default function About() {
  return (
    <section id="about" className="about-section">
      <div className="container">
        <div className="about-inner">

          {/* Left: text content */}
          <div className="about-content">
            <p className="section-label">About</p>
            <h2 className="about-heading">Why AdaptiveCaptions?</h2>
            <p className="about-body">
              Subtitles in educational videos routinely obscure the instructor's face,
              slide text, or code on screen — exactly the content learners need most.
              <span className="about-highlight"> AdaptiveCaptions</span> fixes this by
              analysing each frame with computer vision and OCR, then placing subtitles in the
              open space where they do the least damage to comprehension.
            </p>

            {/* Links row */}
            <div className="about-links">
              <a
                className="about-link about-link--primary"
                href="/Adaptive_captioning_report.pdf"
                target="_blank"
                rel="noopener noreferrer"
                id="about-report-link"
                title="Open Adaptive_captioning_report in a new page"
              >
                <ReportIcon /> View Report ↗
              </a>
              <a className="about-link about-link--primary"
                href="https://github.com/AyushChauhaniitmd/AdaptiveCaptioning"
                target="_blank" rel="noopener noreferrer" id="about-github-link">
                <GitHubIcon /> GitHub
              </a>
            </div>
          </div>

          {/* Right: author info — no card background, just clean text */}
          <div className="about-author-card">
            <div className="about-avatar">AC</div>
            <div className="about-author-info">
              <div className="about-author-label">Author</div>
              <div className="about-author-name">Ayush Chauhan</div>
              <div className="about-author-bio">3rd year B.Tech · IIT Mandi</div>
              <div className="about-author-socials">
                <a className="author-dropdown-link" href="mailto:b24187@students.iitmandi.ac.in"
                  id="about-author-email">
                  <MailIcon /> b24187@students.iitmandi.ac.in
                </a>
                <a className="author-dropdown-link" href="https://www.linkedin.com/in/ayush-chauhan-888538341" target="_blank" rel="noopener noreferrer">
                  <LinkedinIcon /> LinkedIn
                </a>
                <a className="author-dropdown-link" href="https://github.com/AyushChauhaniitmd" target="_blank" rel="noopener noreferrer">
                  <GitHubIcon /> GitHub
                </a>
              </div>
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
