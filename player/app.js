document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const videoInput = document.getElementById('video-input');
    const subtitleInput = document.getElementById('subtitle-input');
    const videoSelect = document.getElementById('video-select');
    const subtitleSelect = document.getElementById('subtitle-select');
    const videoName = document.getElementById('video-name');
    const subtitleName = document.getElementById('subtitle-name');
    
    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('video-player');
    const videoOverlay = document.getElementById('video-overlay');
    const subtitleLayer = document.getElementById('subtitle-layer');
    const regionDebugLayer = document.getElementById('region-debug-layer');
    
    const playPauseBtn = document.getElementById('play-pause-btn');
    const bigPlayBtn = document.getElementById('big-play-btn');
    const muteBtn = document.getElementById('mute-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressBuffer = document.getElementById('progress-buffer');
    
    const captionBtn = document.getElementById('caption-btn');
    const regionDebugBtn = document.getElementById('region-debug-btn');
    const speedBtn = document.getElementById('speed-btn');
    const speedOptions = document.querySelectorAll('.speed-option');
    const fullscreenBtn = document.getElementById('fullscreen-btn');

    let videoUrl = '';
    let parsedCues = [];
    let subtitlesEnabled = true;

    // ─────────────────────────────────────────────────────────
    // REGION POSITIONING MAP
    // Coordinates are expressed as CSS values applied to an
    // absolutely-positioned cue <div> inside #subtitle-layer
    // (which is position:absolute, 100%×100% over the video).
    //
    // Each entry:
    //   top / bottom : vertical anchor (% of video height)
    //   left / right : horizontal anchor (% of video width)
    //   transform    : fine-tune the box relative to its anchor
    //   textAlign    : text alignment inside the box
    //   maxWidth     : cap line length so text stays readable
    // ─────────────────────────────────────────────────────────
    const REGION_STYLES = {
        bottom_center: {
            bottom: '0%', left: '50%',
            transform: 'translateX(-50%)',
            textAlign: 'center', maxWidth: '50%'
        },
        bottom_left: {
            bottom: '0%', left: '0%',
            transform: 'none',
            textAlign: 'left', maxWidth: '35%'
        },
        bottom_right: {
            bottom: '0%', right: '0%',
            transform: 'none',
            textAlign: 'right', maxWidth: '35%'
        },
        middle_left: {
            top: '65%', left: '0%',
            transform: 'none',
            textAlign: 'left', maxWidth: '45%'
        },
        middle_right: {
            top: '65%', right: '0%',
            transform: 'none',
            textAlign: 'right', maxWidth: '45%'
        },
        upper_left: {
            top: '50%', left: '0%',
            transform: 'none',
            textAlign: 'left', maxWidth: '45%'
        },
        upper_right: {
            top: '50%', right: '0%',
            transform: 'none',
            textAlign: 'right', maxWidth: '45%'
        },
        top_center: {
            top: '25%', left: '50%',
            transform: 'translateX(-50%)',
            textAlign: 'center', maxWidth: '70%'
        }
    };

    // Fallback when the VTT has no region tag (or unrecognised value)
    const FALLBACK_REGION = 'bottom_center';

    const REGION_DEBUG_AREAS = {
        bottom_center: { x: [0.25, 0.75], y: [0.85, 1.00] },
        bottom_left:   { x: [0.00, 0.35], y: [0.85, 1.00] },
        bottom_right:  { x: [0.65, 1.00], y: [0.85, 1.00] },
        middle_left:   { x: [0.00, 0.45], y: [0.65, 0.82] },
        middle_right:  { x: [0.55, 1.00], y: [0.65, 0.82] },
        upper_left:    { x: [0.00, 0.45], y: [0.50, 0.65] },
        upper_right:   { x: [0.55, 1.00], y: [0.50, 0.65] },
        top_center:    { x: [0.15, 0.85], y: [0.25, 0.40] }
    };

    function renderRegionDebugLayer() {
        regionDebugLayer.innerHTML = '';

        Object.entries(REGION_DEBUG_AREAS).forEach(([region, area]) => {
            const box = document.createElement('div');
            box.className = 'region-debug-box';
            box.dataset.region = region;
            box.style.left = `${area.x[0] * 100}%`;
            box.style.top = `${area.y[0] * 100}%`;
            box.style.width = `${(area.x[1] - area.x[0]) * 100}%`;
            box.style.height = `${(area.y[1] - area.y[0]) * 100}%`;

            const label = document.createElement('div');
            label.className = 'region-debug-label';
            label.textContent = region.replace('_', ' ');

            box.appendChild(label);
            regionDebugLayer.appendChild(box);
        });
    }

    function syncRegionDebugLayerBounds() {
        const containerWidth = videoContainer.clientWidth;
        const containerHeight = videoContainer.clientHeight;

        if (!containerWidth || !containerHeight || !video.videoWidth || !video.videoHeight) {
            regionDebugLayer.style.left = '0';
            regionDebugLayer.style.top = '0';
            regionDebugLayer.style.width = '100%';
            regionDebugLayer.style.height = '100%';
            return;
        }

        const containerAspect = containerWidth / containerHeight;
        const videoAspect = video.videoWidth / video.videoHeight;
        let contentWidth = containerWidth;
        let contentHeight = containerHeight;
        let contentLeft = 0;
        let contentTop = 0;

        if (containerAspect > videoAspect) {
            contentHeight = containerHeight;
            contentWidth = contentHeight * videoAspect;
            contentLeft = (containerWidth - contentWidth) / 2;
        } else {
            contentWidth = containerWidth;
            contentHeight = contentWidth / videoAspect;
            contentTop = (containerHeight - contentHeight) / 2;
        }

        regionDebugLayer.style.left = `${contentLeft}px`;
        regionDebugLayer.style.top = `${contentTop}px`;
        regionDebugLayer.style.width = `${contentWidth}px`;
        regionDebugLayer.style.height = `${contentHeight}px`;
    }

    renderRegionDebugLayer();
    syncRegionDebugLayerBounds();

    // ─────────────────────────────────────────────────────────
    // VTT PARSER
    // Parses timestamps AND the region: tag from cue headers.
    //
    // Cue header format produced by the pipeline:
    //   00:00:07.080 --> 00:00:09.040 line:47% position:93% align:right region:upper_right
    //
    // We capture everything after --> as the "settings string"
    // and extract region:<value> from it with a regex.
    // line:/position: are intentionally ignored — we use our
    // own REGION_STYLES coordinates for reliable cross-browser
    // rendering via absolutely-positioned divs.
    // ─────────────────────────────────────────────────────────
    function parseVTTTime(timeStr) {
        // Normalize SRT comma decimals → VTT dot decimals: "00:00:07,080" → "00:00:07.080"
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

        // ── Skip header: WEBVTT line, NOTE blocks, and STYLE blocks ────────
        // We advance until we hit the first real cue timestamp line.
        // A cue timestamp line contains '-->' AND starts with a digit or HH:.
        const isTimestamp = (l) => l.includes('-->') && /^[\d]/.test(l.trim());

        while (i < lines.length) {
            const l = lines[i].trim();
            // STYLE block — skip until closing '}' on its own line
            if (l === 'STYLE') {
                i++;
                while (i < lines.length && lines[i].trim() !== '}') i++;
                i++; // skip the '}' itself
                continue;
            }
            // NOTE block — skip until blank line
            if (l.startsWith('NOTE')) {
                i++;
                while (i < lines.length && lines[i].trim() !== '') i++;
                continue;
            }
            if (isTimestamp(lines[i])) break;
            i++;
        }
        // ──────────────────────────────────────────────────────────────────

        while (i < lines.length) {
            const line = lines[i].trim();

            if (line === '') { i++; continue; }

            // Cue numeric/string ID — skip it if next line is the timestamp
            if (!isTimestamp(lines[i]) && i + 1 < lines.length && isTimestamp(lines[i + 1])) {
                i++;
            }

            const timeLine = lines[i];
            if (!timeLine || !isTimestamp(timeLine)) { i++; continue; }

            // Split on --> to get start and "end + settings"
            const arrowIdx = timeLine.indexOf('-->');
            const startStr = timeLine.slice(0, arrowIdx).trim();
            const afterArrow = timeLine.slice(arrowIdx + 3).trim();

            // End timestamp is everything up to the first space
            const spaceIdx = afterArrow.indexOf(' ');
            const endStr   = spaceIdx === -1 ? afterArrow : afterArrow.slice(0, spaceIdx);
            const settings = spaceIdx === -1 ? '' : afterArrow.slice(spaceIdx + 1);

            const start = parseVTTTime(startStr);
            const end   = parseVTTTime(endStr);

            // Extract region:<value> from settings string
            const regionMatch = settings.match(/\bregion:(\S+)/);
            const region = (regionMatch && REGION_STYLES[regionMatch[1]])
                ? regionMatch[1]
                : FALLBACK_REGION;

            i++;

            // Collect payload lines until blank line or EOF
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

    // ─────────────────────────────────────────────────────────
    // SUBTITLE RENDERER
    // Creates one positioned <div class="cue-box"> per active
    // cue, placed according to its region via inline styles.
    // The subtitle-layer div is a transparent 100%×100% overlay.
    // ─────────────────────────────────────────────────────────
    function buildCueBox(cue) {
        const style = REGION_STYLES[cue.region] || REGION_STYLES[FALLBACK_REGION];

        const box = document.createElement('div');
        box.className = 'cue-box';
        box.style.textAlign = style.textAlign;
        box.style.maxWidth  = style.maxWidth;

        // Apply positional CSS — only set the axes the region uses
        if (style.top    !== undefined) box.style.top    = style.top;
        if (style.bottom !== undefined) box.style.bottom = style.bottom;
        if (style.left   !== undefined) box.style.left   = style.left;
        if (style.right  !== undefined) box.style.right  = style.right;
        if (style.transform)            box.style.transform = style.transform;

        // Render each text line as a <span> so background only wraps the text
        cue.text.split('\n').forEach((lineText, idx) => {
            if (idx > 0) {
                box.appendChild(document.createElement('br'));
            }
            const span = document.createElement('span');
            span.className = 'cue-line';
            span.textContent = lineText;
            box.appendChild(span);
        });

        return box;
    }

    function updateSubtitles(currentTime) {
        subtitleLayer.innerHTML = '';

        if (!subtitlesEnabled || parsedCues.length === 0) return;

        const activeCues = parsedCues.filter(
            c => currentTime >= c.start && currentTime <= c.end
        );

        activeCues.forEach(cue => {
            subtitleLayer.appendChild(buildCueBox(cue));
        });
    }

    // ─────────────────────────────────────────────────────────
    // FILE HANDLING
    // ─────────────────────────────────────────────────────────    // ----- Fetch Manifest & Populate Dropdowns ----- //
    fetch('manifest.json')
        .then(res => res.json())
        .then(data => {
            // Video dropdown (flat list)
            if (data.videos) {
                data.videos.forEach(vid => {
                    const option = document.createElement('option');
                    option.value = vid;
                    // Extract filename from path for display
                    option.textContent = vid.split('/').pop();
                    videoSelect.appendChild(option);
                });
            }
            // Subtitle dropdown — grouped by type so user knows which files shift
            const subs = Array.isArray(data.subtitles)
                ? { adaptive: data.subtitles, baseline: [], srt: [] }
                : (data.subtitles || {});
            const groups = [
                { label: '\u2605 Adaptive VTT \u2014 region-shifting',      list: subs.adaptive || [] },
                { label: 'Baseline VTT \u2014 fixed bottom-center',         list: subs.baseline || [] },
                { label: 'Raw SRT \u2014 no region info (bottom only)',      list: subs.srt      || [] }
            ];
            groups.forEach(({ label, list }) => {
                if (list.length === 0) return;
                const group = document.createElement('optgroup');
                group.label = label;
                list.forEach(path => {
                    const opt = document.createElement('option');
                    opt.value = path;
                    opt.textContent = path.split('/').pop();
                    group.appendChild(opt);
                });
                subtitleSelect.appendChild(group);
            });
        })
        .catch(err => console.error('[Nexus] Could not load manifest.json:', err));

    // ----- File Handling (Local & Server) ----- //
    
    // Server Dropdown: Video
    videoSelect.addEventListener('change', (e) => {
        const path = e.target.value;
        if (path) {
            videoName.textContent = path.split('/').pop();
            if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
            videoUrl = '../' + path;
            video.src = videoUrl;
            // Clear stale subtitle state from previous video
            parsedCues = [];
            subtitleLayer.innerHTML = '';
            videoContainer.classList.add('active', 'paused');
        }
    });

    // Server Dropdown: Subtitle
    subtitleSelect.addEventListener('change', (e) => {
        const path = e.target.value;
        if (!path) return;
        subtitleName.textContent = path.split('/').pop();
        fetch('../' + path)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(text => {
                parsedCues = parseVTT(text);
                console.log(`[Nexus] Loaded ${parsedCues.length} cues from ${path}`);
                subtitlesEnabled = true;
                captionBtn.classList.add('active');
                updateSubtitles(video.currentTime); // render immediately at current position
            })
            .catch(err => console.error('[Nexus] Subtitle load error:', err));
    });

    // Local Input: Video
    videoInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            videoName.textContent = file.name;
            videoSelect.value = '';
            if (videoUrl && videoUrl.startsWith('blob:')) URL.revokeObjectURL(videoUrl);
            videoUrl = URL.createObjectURL(file);
            video.src = videoUrl;
            // Clear stale subtitle state from previous video
            parsedCues = [];
            subtitleLayer.innerHTML = '';
            videoContainer.classList.add('active', 'paused');
        }
    });

    // Local Input: Subtitle
    subtitleInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            subtitleName.textContent = file.name;
            subtitleSelect.value = ''; // Reset dropdown
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const text = event.target.result;
                parsedCues = parseVTT(text);
                subtitlesEnabled = true;
                captionBtn.classList.add('active');
                updateSubtitles(video.currentTime);
            };
            reader.readAsText(file);
        }
    });// ─────────────────────────────────────────────────────────
    // FORMAT TIME
    // ─────────────────────────────────────────────────────────
    function formatTime(seconds) {
        if (isNaN(seconds)) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    // ─────────────────────────────────────────────────────────
    // PLAYBACK CONTROLS
    // ─────────────────────────────────────────────────────────
    function togglePlay() {
        video.paused ? video.play() : video.pause();
    }

    playPauseBtn.addEventListener('click', togglePlay);
    videoOverlay.addEventListener('click', togglePlay);

    video.addEventListener('play', () => {
        videoContainer.classList.remove('paused');
        videoContainer.classList.add('playing');
        playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        bigPlayBtn.innerHTML   = '<i class="fa-solid fa-pause"></i>';
    });

    video.addEventListener('pause', () => {
        videoContainer.classList.add('paused');
        videoContainer.classList.remove('playing');
        playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        bigPlayBtn.innerHTML   = '<i class="fa-solid fa-play"></i>';
    });

    video.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatTime(video.duration);
        syncRegionDebugLayerBounds();
        updateProgress(video.currentTime);
        updateSubtitles(video.currentTime); // show cues if already at t=0
    });

    let isScrubbing = false;
    let wasPlayingBeforeScrub = false;
    let scrubResumeTimer = null;
    let scrubStartTime = 0;
    let lastScrubTime = 0;

    function updateProgress(time) {
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
            progressBar.style.width = '0%';
            currentTimeEl.textContent = '00:00';
            return;
        }

        const pct = Math.max(0, Math.min(100, (time / video.duration) * 100));
        progressBar.style.width = `${pct}%`;
        currentTimeEl.textContent = formatTime(time);
    }

    function getSeekTime(clientX) {
        const rect = progressContainer.getBoundingClientRect();
        if (rect.width <= 0) return video.currentTime;
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return pos * video.duration;
    }

    function getScrubTime(clientX) {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;

        return getSeekTime(clientX);
    }

    function previewScrub(clientX) {
        const scrubTime = getScrubTime(clientX);
        if (scrubTime === undefined) return;

        lastScrubTime = scrubTime;
        updateProgress(scrubTime);
        updateSubtitles(scrubTime);
    }

    function resumeAfterSeek() {
        clearTimeout(scrubResumeTimer);
        scrubResumeTimer = null;
        video.play().catch(err => console.error(`[Nexus] Resume after seek failed: ${err.message}`));
    }

    function commitScrub(shouldResume) {
        const scrubTime = Math.max(0, Math.min(video.duration, lastScrubTime));
        updateProgress(scrubTime);
        updateSubtitles(scrubTime);

        video.currentTime = scrubTime;

        if (!shouldResume) return;

        if (video.seeking) {
            video.addEventListener('seeked', resumeAfterSeek, { once: true });
            scrubResumeTimer = setTimeout(resumeAfterSeek, 250);
        } else {
            resumeAfterSeek();
        }
    }

    // Re-render on every kind of position change
    video.addEventListener('timeupdate', () => {
        if (!isScrubbing) updateProgress(video.currentTime);
        updateSubtitles(video.currentTime);
    });

    video.addEventListener('seeked', () => updateSubtitles(video.currentTime));
    video.addEventListener('pause',  () => updateSubtitles(video.currentTime));

    video.addEventListener('progress', () => {
        if (video.buffered.length > 0 && video.duration > 0) {
            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            progressBuffer.style.width = `${(bufferedEnd / video.duration) * 100}%`;
        }
    });

    // Seek / scrub
    progressContainer.addEventListener('pointerdown', (e) => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;

        e.preventDefault();
        wasPlayingBeforeScrub = !video.paused && !video.ended;
        scrubStartTime = video.currentTime;
        lastScrubTime = video.currentTime;
        video.pause();
        isScrubbing = true;
        progressContainer.classList.add('scrubbing');
        progressContainer.setPointerCapture(e.pointerId);
        previewScrub(e.clientX);
    });

    progressContainer.addEventListener('pointermove', (e) => {
        if (!isScrubbing) return;
        e.preventDefault();
        previewScrub(e.clientX);
    });

    function stopScrubbing(e) {
        if (!isScrubbing) return;

        const shouldResume = wasPlayingBeforeScrub;
        isScrubbing = false;
        wasPlayingBeforeScrub = false;
        progressContainer.classList.remove('scrubbing');
        if (progressContainer.hasPointerCapture(e.pointerId)) {
            progressContainer.releasePointerCapture(e.pointerId);
        }
        commitScrub(shouldResume);
    }

    progressContainer.addEventListener('pointerup', stopScrubbing);
    progressContainer.addEventListener('pointercancel', (e) => {
        if (!isScrubbing) return;

        const shouldResume = wasPlayingBeforeScrub;
        isScrubbing = false;
        wasPlayingBeforeScrub = false;
        lastScrubTime = scrubStartTime;
        progressContainer.classList.remove('scrubbing');
        if (progressContainer.hasPointerCapture(e.pointerId)) {
            progressContainer.releasePointerCapture(e.pointerId);
        }
        commitScrub(shouldResume);
    });

    // Volume
    muteBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        updateVolumeIcon();
    });

    volumeSlider.addEventListener('input', (e) => {
        video.volume = e.target.value;
        video.muted  = e.target.value === '0';
        updateVolumeIcon();
    });

    function updateVolumeIcon() {
        if (video.muted || video.volume === 0) {
            muteBtn.innerHTML   = '<i class="fa-solid fa-volume-xmark"></i>';
            volumeSlider.value  = 0;
        } else if (video.volume < 0.5) {
            muteBtn.innerHTML   = '<i class="fa-solid fa-volume-low"></i>';
            volumeSlider.value  = video.volume;
        } else {
            muteBtn.innerHTML   = '<i class="fa-solid fa-volume-high"></i>';
            volumeSlider.value  = video.volume;
        }
    }

    // Captions toggle
    captionBtn.addEventListener('click', () => {
        if (parsedCues.length === 0) return;
        subtitlesEnabled = !subtitlesEnabled;
        captionBtn.classList.toggle('active', subtitlesEnabled);
        updateSubtitles(video.currentTime);
    });

    // Region debug overlay
    regionDebugBtn.addEventListener('click', () => {
        const showRegions = videoContainer.classList.toggle('show-regions');
        regionDebugBtn.classList.toggle('active', showRegions);
        regionDebugBtn.title = showRegions ? 'Hide Scoring Regions' : 'Show Scoring Regions';
    });

    // Speed
    speedOptions.forEach(option => {
        option.addEventListener('click', () => {
            const speed = parseFloat(option.dataset.speed);
            video.playbackRate = speed;
            speedBtn.textContent = `${speed}x`;
            speedOptions.forEach(o => o.classList.remove('active'));
            option.classList.add('active');
        });
    });

    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            videoContainer.requestFullscreen().catch(err =>
                console.error(`Fullscreen error: ${err.message}`)
            );
        } else {
            document.exitFullscreen();
        }
    });

    document.addEventListener('fullscreenchange', () => {
        syncRegionDebugLayerBounds();
        fullscreenBtn.innerHTML = document.fullscreenElement
            ? '<i class="fa-solid fa-compress"></i>'
            : '<i class="fa-solid fa-expand"></i>';
    });

    window.addEventListener('resize', syncRegionDebugLayerBounds);
    if ('ResizeObserver' in window) {
        new ResizeObserver(syncRegionDebugLayerBounds).observe(videoContainer);
    }

    // Idle state
    let idleTimeout;
    const hideControls  = () => { if (!video.paused && !video.ended) videoContainer.classList.add('idle'); };
    const resetIdleTimer = () => {
        videoContainer.classList.remove('idle');
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(hideControls, 3000);
    };
    videoContainer.addEventListener('mousemove',  resetIdleTimer);
    videoContainer.addEventListener('mousedown',  resetIdleTimer);
    videoContainer.addEventListener('touchstart', resetIdleTimer);
    videoContainer.addEventListener('mouseleave', () => { if (!video.paused) hideControls(); });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT') return;
        switch (e.code) {
            case 'Space': case 'KeyK':
                e.preventDefault(); togglePlay(); resetIdleTimer(); break;
            case 'ArrowRight':
                e.preventDefault(); video.currentTime += 5; resetIdleTimer(); break;
            case 'ArrowLeft':
                e.preventDefault(); video.currentTime -= 5; resetIdleTimer(); break;
            case 'KeyF':
                e.preventDefault(); fullscreenBtn.click(); break;
            case 'KeyM':
                e.preventDefault(); muteBtn.click(); resetIdleTimer(); break;
            case 'KeyC':
                e.preventDefault(); captionBtn.click(); resetIdleTimer(); break;
            case 'KeyR':
                e.preventDefault(); regionDebugBtn.click(); resetIdleTimer(); break;
        }
    });
});
