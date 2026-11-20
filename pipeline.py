"""
pipeline.py — Adaptive Subtitle Placement System
Main entry point.

Usage:
    python pipeline.py --video coding_001 --transition instant
    python pipeline.py --video coding_001 --transition instant --debug

Output:
    processed/{type}/{video_id}_adaptive.vtt
    processed/{type}/{video_id}_baseline.vtt
    outputs/metrics/{video_id}_metrics.json
    outputs/debug/{video_id}_debug.csv   (--debug only)
"""

import argparse
import csv
import json
import math
import os
import re
import time
import warnings
import subprocess
import tempfile
from pathlib import Path

import cv2
import easyocr
import numpy as np
import pandas as pd
import pysrt
import torch


warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────
# 0. CONSTANTS & REGION DEFINITIONS
# ─────────────────────────────────────────────

REGIONS = [
    # wrap_chars: chars-per-line scaled to region horizontal width.
    # Anchor: bottom_center width=0.50 → 38 chars  (76 chars per 1.0 unit width).
    {"name": "bottom_center",  "x": (0.25, 0.75), "y": (0.85, 1.00), "base": 1,   "wrap_chars": 38},
    {"name": "bottom_left",    "x": (0.00, 0.35), "y": (0.85, 1.00), "base": 1,   "wrap_chars": 27},
    {"name": "bottom_right",   "x": (0.65, 1.00), "y": (0.85, 1.00), "base": 1,   "wrap_chars": 27},
    {"name": "middle_left",    "x": (0.00, 0.45), "y": (0.65, 0.82), "base": 1.2, "wrap_chars": 34},
    {"name": "middle_right",   "x": (0.55, 1.00), "y": (0.65, 0.82), "base": 1.2, "wrap_chars": 34},
    {"name": "upper_left",     "x": (0.00, 0.45), "y": (0.50, 0.65), "base": 1.2, "wrap_chars": 34},
    {"name": "upper_right",    "x": (0.55, 1.00), "y": (0.50, 0.65), "base": 1.2, "wrap_chars": 34},
    {"name": "top_center",     "x": (0.15, 0.85), "y": (0.25, 0.40), "base": 1.5, "wrap_chars": 53},
]

# Per-region wrap limit lookup — derived from wrap_chars field above.
REGION_WRAP_CHARS = {r["name"]: r["wrap_chars"] for r in REGIONS}

SCORE_WEIGHTS = {
    "ocr_overlap":      5.0,
    "edge_density":     4.0,
    "active_writing":   3.0,   # top-1 writing region: 1.00 * 3.0 = 3.0 penalty
                                # top-2 writing region: 0.67 * 3.0 = 2.0 penalty
    # cursor_movement, board_change removed (Phase 5).
    # See report.tex Section 17 for full rationale and restoration guide.
    # region_switch removed (Phase 5) — switch_penalty was double-counting
    # with TemporalSmoother's hysteresis. Both resist switching; combined
    # they inflated the effective gap by +1.15, masking genuinely better
    # regions. Anti-jitter is now handled solely by hysteresis + dwell timer.
}

ANALYSIS_W, ANALYSIS_H = 640, 360
SHORT_SUBTITLE_THRESHOLD = 5       # word count < this → skip recompute
DWELL_MIN_SECONDS        = 0.5
SCORE_GAP_THRESHOLD      = 0.20
HYSTERESIS_DISCOUNT      = 0.15
    # MOTION_NOISE_THRESHOLD and MOTION_LARGE_THRESHOLD removed (Phase 5).
CONTENT_SIMILARITY_THRESHOLD = 0.92  # histogram pre-filter correlation threshold
SIMILARITY_MAD_THRESHOLD     = 3.0   # pixel MAD gate (H.264 noise ≈ 1–2.5; slide change ≈ 8–25)

# ── Active writing detection constants (Phase 6) ─────────────────────────────
WRITING_FRAME_INTERVAL      = 10     # sample every Nth frame within subtitle window
WRITING_DIVISION_T          = 3      # threshold divisor: floor(n / t) active frames needed
WRITING_DIFF_THRESHOLD      = 0.06   # normalised pixel diff to count as "changed"
WRITING_MAX_COMPONENT_RATIO = 0.02   # max connected component area as fraction of region
                                     # (filters out large blobs: slide transitions, persons)
WRITING_MIN_INK_DENSITY     = 0.005  # min fraction of region pixels with persistent ink

# ── Subtitle wrapping policy ──────────────────
# WRAP_MAX_CHARS_PER_LINE is the global fallback used for the initial
# word-count pass before a region is chosen.  After region selection,
# each subtitle is re-wrapped using REGION_WRAP_CHARS[chosen_region]
# so the line length matches the actual horizontal space available.
WRAP_MAX_CHARS_PER_LINE = 38
WRAP_MAX_LINES = 2


# ─────────────────────────────────────────────
# 1. FOLDER SETUP
# ─────────────────────────────────────────────

def ensure_dirs():
    for d in [
        "outputs/debug",
        "outputs/metrics",
        "processed/coding",
        "processed/ppt",
        "processed/smartboard",
    ]:
        Path(d).mkdir(parents=True, exist_ok=True)


# ─────────────────────────────────────────────
# 2. LOAD METADATA
# ─────────────────────────────────────────────

def load_video_meta(video_id: str) -> dict:
    df = pd.read_csv("metadata/master.csv")
    row = df[df["video_id"] == video_id]
    if row.empty:
        raise ValueError(f"Video '{video_id}' not found in master.csv")
    return row.iloc[0].to_dict()


# ─────────────────────────────────────────────
# 3. DETECTOR SETUP
# ─────────────────────────────────────────────

def setup_detectors(device: str):
    print(f"[INFO] Loading detectors on {device.upper()} ...")
    reader = easyocr.Reader(["en"], gpu=(device == "cuda"), verbose=False)
    print("[INFO] Detectors ready.")
    return reader


# ─────────────────────────────────────────────
# 4. FRAME EXTRACTION
# ─────────────────────────────────────────────

def extract_frame(cap: cv2.VideoCapture, timestamp_sec: float, start_time_offset: float = 0.0):
    """Extract a single frame at timestamp_sec. Returns BGR frame or None."""
    cv2_time = max(0.0, timestamp_sec - start_time_offset)
    cap.set(cv2.CAP_PROP_POS_MSEC, cv2_time * 1000)
    ret, frame = cap.read()
    if not ret:
        return None
    return frame


def resize_frame(frame):
    """Resize to analysis resolution."""
    return cv2.resize(frame, (ANALYSIS_W, ANALYSIS_H))


def writing_sample_times(fps: float, sub_start_sec: float, sub_end_sec: float) -> list[float]:
    """Return the timestamps used by the persistent-ink detector."""
    frame_step_sec = WRITING_FRAME_INTERVAL / max(fps, 1.0)
    times = []
    timestamp = sub_start_sec + frame_step_sec
    while timestamp < sub_end_sec:
        times.append(timestamp)
        timestamp += frame_step_sec
    return times


def extract_analysis_frames_in_order(cap: cv2.VideoCapture, timestamps: list[float],
                                     start_time_offset: float = 0.0) -> dict[float, np.ndarray]:
    """Decode requested frames in timestamp order with one seek per subtitle.

    OpenCV's timestamp seeking has to decode from a preceding keyframe.  The
    original implementation did that separately for every writing sample and
    every scoring frame.  Caption timestamps are naturally ordered, so seek
    once to the first one, read forward, and retain only 640x360 analysis
    frames.  This keeps memory bounded while avoiding repeated 1080p seeks.
    """
    ordered = sorted(set(timestamps))
    if not ordered:
        return {}

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    first_video_time = max(0.0, ordered[0] - start_time_offset)
    cap.set(cv2.CAP_PROP_POS_MSEC, first_video_time * 1000)

    frames = {}
    ret, frame = cap.read()
    if not ret:
        return frames

    last_frame_index = max(0, int(cap.get(cv2.CAP_PROP_POS_FRAMES)) - 1)
    frames[ordered[0]] = resize_frame(frame)

    for timestamp in ordered[1:]:
        target_index = max(0, int(round((timestamp - start_time_offset) * fps)))
        if target_index > last_frame_index:
            # grab() advances without retrieving/colour-converting the frame
            while last_frame_index < target_index - 1:
                if not cap.grab():
                    return frames
                last_frame_index += 1
            ret, frame = cap.read()
            if not ret:
                return frames
            last_frame_index = target_index
        frames[timestamp] = resize_frame(frame)

    return frames


class FrameStream:
    """
    Sequential 640x360 BGR frame reader backed by ONE ffmpeg process.

    Why: with OpenCV, every cap.set() seek re-decodes from the previous
    keyframe (~1.9 s each on the AV1 demo video) and cap.read() decodes on the
    CPU (~16 ms per 1920x960 frame).  Here each frame is decoded at most once,
    in order, with NVDEC when available (automatic CPU fallback), scaled to
    analysis size inside ffmpeg, and piped back as raw BGR.

    frames_at() should be called with non-decreasing timestamps.  A request
    behind the current position, or a very long jump ahead, transparently
    restarts ffmpeg with an accurate seek (counted in .restarts).
    """

    JUMP_RESTART_FRAMES = 1500          # jump ahead further than this -> restart with -ss

    def __init__(self, video_path: str, fps: float, start_time_offset: float = 0.0,
                 use_gpu: bool = True):
        self.path = str(video_path)
        self.fps = fps if fps and fps > 0 else 25.0
        self.offset = start_time_offset
        self.use_gpu = use_gpu
        self.frame_bytes = ANALYSIS_W * ANALYSIS_H * 3
        self.proc = None
        self.next_index = 0
        self.restarts = 0
        self._err = None
        self._fresh = True
        self._ever_read = False
        self._start(0)

    def _start(self, index: int):
        self.close()
        cmd = ["ffmpeg", "-nostdin", "-loglevel", "error"]
        if self.use_gpu:
            cmd += ["-hwaccel", "cuda"]
        if index > 0:
            cmd += ["-ss", f"{index / self.fps:.6f}"]   # relative to stream start_time
        cmd += ["-i", self.path, "-map", "0:v:0", "-an", "-sn",
                "-vf", f"scale={ANALYSIS_W}:{ANALYSIS_H}:flags=bilinear",
                "-pix_fmt", "bgr24", "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
        self._err = tempfile.TemporaryFile()
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=self._err, bufsize=self.frame_bytes * 4)
        self.next_index = index
        self._fresh = True

    def _stderr_tail(self) -> str:
        try:
            self._err.seek(0)
            return self._err.read().decode("utf-8", "replace")[-600:].strip()
        except Exception:
            return ""

    def _read(self):
        """Return one raw frame (bytes) or None at end of stream."""
        data = self.proc.stdout.read(self.frame_bytes)
        if len(data) == self.frame_bytes:
            self._fresh = False
            self._ever_read = True
            return data
        if self._fresh and self.use_gpu and not data:
            print(f"[WARN] ffmpeg NVDEC decode failed, falling back to CPU decode. "
                  f"{self._stderr_tail()}")
            self.use_gpu = False
            self._start(self.next_index)
            return self._read()
        if not self._ever_read:
            raise RuntimeError(f"ffmpeg produced no frames for {self.path}: {self._stderr_tail()}")
        return None

    def frames_at(self, timestamps) -> dict:
        """Map each timestamp -> 640x360 BGR frame (read-only). Missing past EOF."""
        want = {}
        for t in timestamps:
            idx = max(0, int(round((t - self.offset) * self.fps)))
            want.setdefault(idx, []).append(t)
        out = {}
        if not want:
            return out

        first = min(want)
        if first < self.next_index or first - self.next_index > self.JUMP_RESTART_FRAMES:
            self.restarts += 1
            self._start(first)

        for idx in sorted(want):
            while self.next_index < idx:                  # decode-and-discard
                if self._read() is None:
                    return out
                self.next_index += 1
            data = self._read()
            if data is None:
                return out
            self.next_index += 1
            frame = np.frombuffer(data, dtype=np.uint8).reshape(ANALYSIS_H, ANALYSIS_W, 3)
            for t in want[idx]:
                out[t] = frame
        return out

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdout.close()
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.proc = None
        if self._err is not None:
            try:
                self._err.close()
            except Exception:
                pass
            self._err = None


def frames_are_similar(frame_a, frame_b,
                       hist_threshold: float = CONTENT_SIMILARITY_THRESHOLD,
                       mad_threshold: float = SIMILARITY_MAD_THRESHOLD) -> bool:
    """
    Two-stage visual similarity check.

    Stage 1 — Histogram pre-filter (cheap):
        64-bin grayscale histogram on a 64×64 thumbnail.
        If Pearson correlation < hist_threshold → return False immediately.

    Stage 2 — Pixel MAD gate:
        Catches same-template PPT slide changes where histograms match
        but content differs. If MAD > mad_threshold → return False.

    Returns True only when BOTH gates pass (content unchanged).
    """
    thumb_a = cv2.resize(cv2.cvtColor(frame_a, cv2.COLOR_BGR2GRAY), (64, 64))
    thumb_b = cv2.resize(cv2.cvtColor(frame_b, cv2.COLOR_BGR2GRAY), (64, 64))

    hist_a = cv2.calcHist([thumb_a], [0], None, [64], [0, 256])
    hist_b = cv2.calcHist([thumb_b], [0], None, [64], [0, 256])
    if cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL) < hist_threshold:
        return False

    mad = np.mean(np.abs(thumb_a.astype(np.float32) - thumb_b.astype(np.float32)))
    if float(mad) > mad_threshold:
        return False

    # Stage 3 — Structural difference check
    # The 64x64 MAD dilutes small text additions (e.g. bullet points or handwriting).
    # We check full-resolution differences, blurred to resist H.264 camera noise.
    gray_a = cv2.cvtColor(frame_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(frame_b, cv2.COLOR_BGR2GRAY)
    blur_a = cv2.GaussianBlur(gray_a, (5, 5), 0)
    blur_b = cv2.GaussianBlur(gray_b, (5, 5), 0)
    diff = cv2.absdiff(blur_a, blur_b)
    _, thresh = cv2.threshold(diff, 15, 255, cv2.THRESH_BINARY)
    
    if cv2.countNonZero(thresh) > 100:
        return False

    return True


# ─────────────────────────────────────────────
# 5. REGION MASK HELPERS
# ─────────────────────────────────────────────

def region_mask(region: dict, h: int, w: int) -> np.ndarray:
    """Boolean mask for a region at given frame size."""
    mask = np.zeros((h, w), dtype=bool)
    y1 = int(region["y"][0] * h)
    y2 = int(region["y"][1] * h)
    x1 = int(region["x"][0] * w)
    x2 = int(region["x"][1] * w)
    mask[y1:y2, x1:x2] = True
    return mask


    # person_box_mask removed (Phase 5) — was used only to zero out
    # motion diffs inside detected person bounding boxes before computing
    # active_writing / cursor_movement / board_change. Removed together
    # with those three motion features. See report.tex Section 17.


# ─────────────────────────────────────────────
# 6. FEATURE EXTRACTORS
# ─────────────────────────────────────────────

def compute_edge_map(frame_small) -> np.ndarray:
    """Canny edge map for the whole frame (computed once per frame)."""
    gray = cv2.cvtColor(frame_small, cv2.COLOR_BGR2GRAY)
    return cv2.Canny(gray, 50, 150)


def compute_edge_density(edges: np.ndarray, region: dict) -> float:
    """Edge density inside region from a precomputed edge map."""
    h, w = edges.shape
    y1, y2 = int(region["y"][0] * h), int(region["y"][1] * h)
    x1, x2 = int(region["x"][0] * w), int(region["x"][1] * w)
    sub = edges[y1:y2, x1:x2]
    if sub.size == 0:
        return 0.0
    return float(np.count_nonzero(sub)) / sub.size


def compute_ocr_overlap_all(reader, frame_small, regions=None, gap: int = 24) -> dict:
    """
    One EasyOCR call for all regions. Crops are stacked vertically on a black
    canvas separated by gaps; each detection is assigned back to its region by
    vertical position. Same metric as compute_ocr_overlap (conf >= 0.4, text
    box area / crop area, clamped to 1.0).
    """
    regions = regions or REGIONS
    h, w = frame_small.shape[:2]
    crops, slots = [], {}
    y_cursor = 0
    for region in regions:
        x1, x2 = int(region["x"][0] * w), int(region["x"][1] * w)
        y1, y2 = int(region["y"][0] * h), int(region["y"][1] * h)
        crop = frame_small[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        ch, cw = crop.shape[:2]
        slots[region["name"]] = (y_cursor, y_cursor + ch, cw, ch)
        crops.append((y_cursor, crop))
        y_cursor += ch + gap

    scores = {r["name"]: 0.0 for r in regions}
    if not crops:
        return scores
    canvas = np.zeros((y_cursor, w, 3), dtype=np.uint8)
    for y0, crop in crops:
        canvas[y0:y0 + crop.shape[0], :crop.shape[1]] = crop

    results = reader.readtext(canvas, detail=1, paragraph=False)
    covered = {name: 0 for name in slots}
    for (bbox, _text, conf) in results:
        if conf < 0.4:
            continue
        pts = np.array(bbox, dtype=np.int32)
        cy = (pts[:, 1].min() + pts[:, 1].max()) / 2
        for name, (ys, ye, cw, ch) in slots.items():
            if ys <= cy < ye:
                bx1 = max(0, pts[:, 0].min()); bx2 = min(cw, pts[:, 0].max())
                by1 = max(ys, pts[:, 1].min()) - ys; by2 = min(ye, pts[:, 1].max()) - ys
                covered[name] += max(0, bx2 - bx1) * max(0, by2 - by1)
                break
    for name, (_ys, _ye, cw, ch) in slots.items():
        scores[name] = min(1.0, covered[name] / (cw * ch))
    return scores


def compute_ocr_overlap(reader, frame_small, region: dict) -> float:
    """
    Measure how much text area occupies the subtitle region.

    Why crop-first?
    ---------------
    Running EasyOCR on the full 640×360 analysis frame causes confidence
    collapse for small text strips (e.g. top_center is only 448×54 px).
    CRAFT's heatmap is dominated by large slide content, yielding conf
    0.05–0.18 for text that scores 0.69–1.00 when the crop is fed alone.
    Cropping first focuses EasyOCR on the region's own pixels.

    Metric — text-area coverage ratio
    ----------------------------------
    For each confident detection (conf >= 0.4) inside the crop, accumulate
    the bounding-box pixel area.  Divide by total crop area to get the
    fraction of the region covered by text.  This is proportional: a region
    densely filled with text scores near 1.0; sparse or single-word text
    scores proportionally lower.  Clamped to [0.0, 1.0].

    Returns 0.0–1.0.
    """
    h, w = frame_small.shape[:2]

    x1 = int(region["x"][0] * w)
    x2 = int(region["x"][1] * w)
    y1 = int(region["y"][0] * h)
    y2 = int(region["y"][1] * h)

    crop = frame_small[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0

    crop_h, crop_w = crop.shape[:2]
    crop_area = crop_h * crop_w

    results = reader.readtext(crop, detail=1, paragraph=False)
    if not results:
        return 0.0

    covered_area = 0
    for (bbox, _text, conf) in results:
        if conf < 0.4:
            continue
        pts = np.array(bbox, dtype=np.int32)
        bx1 = max(0, pts[:, 0].min())
        by1 = max(0, pts[:, 1].min())
        bx2 = min(crop_w, pts[:, 0].max())
        by2 = min(crop_h, pts[:, 1].max())
        covered_area += max(0, bx2 - bx1) * max(0, by2 - by1)

    return min(1.0, covered_area / crop_area)


    # compute_motion_features removed (Phase 5) — computed active_writing,
    # cursor_movement, board_change via frame pixel diff. Removed due to:
    # (1) false positives from stale prev_frame across similarity-skip streaks,
    # (2) slide transitions misclassified as active_writing (weight 4.5),
    # (3) real handwriting under-detected (quadrant brightness heuristic too crude).
    # New writing/cursor detection to be designed from scratch.
    # See report.tex Section 17 for full code and restoration guide.


def compute_active_writing(cap: cv2.VideoCapture,
                           fps: float,
                           sub_start_sec: float,
                           sub_end_sec: float,
                           start_time_offset: float = 0.0,
                           analysis_frames: dict[float, np.ndarray] | None = None) -> dict:
    """
    Detect active handwriting/marker-writing in each of the 8 regions
    by measuring permanent ink accumulation across the subtitle window.

    Algorithm (Phase 6 — ink persistence approach)
    -----------------------------------------------
    Uses two frames per sample: f₀ (the subtitle's first frame, "before
    writing started") and fᵢ (every Nth frame within the window). A region
    is marked active for sample i if the diff |fᵢ - f₀| reveals small,
    persistent, spatially compact brightness changes — i.e. new ink/chalk
    that wasn't there at the start of the subtitle.

    Why this correctly rejects presenter motion
    --------------------------------------------
    A presenter speaking or gesturing moves their body but the board behind
    them looks the same at fᵢ as at f₀ — no permanent brightness change
    survives. Only actual ink (which stays on the surface) accumulates a
    persistent diff against f₀.

    Steps per sample frame fᵢ
    --------------------------
    1. Permanence gate:     diff = |fᵢ - f₀| normalised; keep pixels > threshold
    2. Compactness gate:    remove connected components larger than
                            WRITING_MAX_COMPONENT_RATIO × region_pixels
                            (filters slide transitions, person silhouettes)
    3. Per-region density:  surviving_pixels_in_region / region_pixels
                            → frame_is_active[region] = density > MIN_INK_DENSITY

    Aggregation
    -----------
    n  = number of samples taken from the window
    threshold = floor(n / WRITING_DIVISION_T)

    Qualifying regions: active_count >= threshold
    Ranked by active_count descending, penalise only TOP 2:
        rank 1 → writing_score = 1.00  (penalty: 1.00 × 3.0 = 3.0)
        rank 2 → writing_score = 0.67  (penalty: 0.67 × 3.0 ≈ 2.0)
        others → writing_score = 0.0

    Called once per subtitle entry (not per frame), so it is completely
    immune to the MAX-aggregation problem that plagued the old approach.

    Parameters
    ----------
    cap               : open VideoCapture for the current video
    fps               : video frame rate (used to compute frame-based interval)
    sub_start_sec     : subtitle entry start time in seconds
    sub_end_sec       : subtitle entry end time in seconds
    start_time_offset : container start_time correction (from ffprobe)

    Returns
    -------
    dict mapping region_name → writing_score (0.0, 0.67, or 1.0)
    """
    # Default — all regions clear
    writing_scores = {r["name"]: 0.0 for r in REGIONS}

    # f₀ — reference frame: content at the very start of the subtitle window,
    # before any new ink could have been added during this entry.
    f0_timestamp = sub_start_sec + 0.1
    if analysis_frames is None:
        f0_raw = extract_frame(cap, f0_timestamp, start_time_offset)
        f0 = resize_frame(f0_raw) if f0_raw is not None else None
    else:
        f0 = analysis_frames.get(f0_timestamp)
    if f0 is None:
        return writing_scores
    f0_gray = cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

    # Build sample timestamps: every WRITING_FRAME_INTERVAL frames
    # starting just after f₀ so we're measuring change, not comparing f₀ to itself.
    sample_times = writing_sample_times(fps, sub_start_sec, sub_end_sec)

    n = len(sample_times)
    if n == 0:
        return writing_scores

    threshold = math.floor(n / WRITING_DIVISION_T)

    # Per-region active frame counter
    active_counts = {r["name"]: 0 for r in REGIONS}

    for t_sample in sample_times:
        if analysis_frames is None:
            fi_raw = extract_frame(cap, t_sample, start_time_offset)
            fi = resize_frame(fi_raw) if fi_raw is not None else None
        else:
            fi = analysis_frames.get(t_sample)
        if fi is None:
            continue
        fi_gray = cv2.cvtColor(fi, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0

        # Permanence gate: pixels that changed meaningfully vs f₀
        diff = np.abs(fi_gray - f0_gray)
        permanent_mask = (diff > WRITING_DIFF_THRESHOLD).astype(np.uint8)

        # Compactness gate: remove large connected components
        # (slide transitions produce a single massive component; ink strokes are small)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(
            permanent_mask, connectivity=8
        )
        total_frame_pixels = permanent_mask.size
        # Vectorised: keep components whose area is small enough (label 0 = background)
        keep = (stats[:, cv2.CC_STAT_AREA] / total_frame_pixels) <= WRITING_MAX_COMPONENT_RATIO
        keep[0] = False
        filtered_mask = keep[labels].astype(np.uint8)

        # Per-region: check ink density in surviving pixels
        h, w = filtered_mask.shape
        for region in REGIONS:
            r_mask = region_mask(region, h, w)
            region_pixels = r_mask.sum()
            if region_pixels == 0:
                continue
            ink_pixels = filtered_mask[r_mask].sum()
            ink_density = ink_pixels / region_pixels
            if ink_density > WRITING_MIN_INK_DENSITY:
                active_counts[region["name"]] += 1

    # Qualify regions that meet the persistence threshold
    qualifying = {
        name: count
        for name, count in active_counts.items()
        if count >= threshold
    }

    if not qualifying:
        return writing_scores

    # Rank by active_count descending, penalise only top 2
    ranked = sorted(qualifying.items(), key=lambda x: -x[1])
    if len(ranked) >= 1:
        writing_scores[ranked[0][0]] = 1.00   # top-1 → full penalty (3.0)
    if len(ranked) >= 2:
        writing_scores[ranked[1][0]] = 0.67   # top-2 → reduced penalty (~2.0)

    return writing_scores


# ─────────────────────────────────────────────
# 7. SCORE A SINGLE FRAME FOR ALL REGIONS
# ─────────────────────────────────────────────

def score_frame(frame_curr, frame_prev, reader, writing_scores: dict = None,
                run_ocr: bool = True, is_analysis_frame: bool = False,
                timings: dict | None = None):
    """
    Returns list of score dicts for all 8 regions.

    writing_scores: pre-computed dict {region_name: 0.0 / 0.67 / 1.0}
        from compute_active_writing(). Computed ONCE per subtitle entry
        (not per frame) and passed in here for all 3 scoring frames.
        If None (e.g. similarity-skipped entries), treated as all 0.0.

    frame_prev kept in signature for when cursor detection is added.
    current_region_name removed (Phase 5) — switch_penalty deleted.
    """
    small_curr = frame_curr if is_analysis_frame else resize_frame(frame_curr)
    if writing_scores is None:
        writing_scores = {r["name"]: 0.0 for r in REGIONS}

    ocr_start = time.perf_counter()
    ocr_scores = compute_ocr_overlap_all(reader, small_curr) if run_ocr else {}
    if timings is not None:
        timings["ocr_seconds"] = timings.get("ocr_seconds", 0.0) + (time.perf_counter() - ocr_start)
        timings["ocr_calls"] = timings.get("ocr_calls", 0) + int(run_ocr)
    edge_map = compute_edge_map(small_curr)   # once per frame, not once per region

    scores = []
    for region in REGIONS:
        base    = region["base"]
        ocr     = ocr_scores.get(region["name"], 0.0)
        edge    = compute_edge_density(edge_map, region)
        writing = writing_scores.get(region["name"], 0.0)

        if ocr > 0.15:
            edge = 0.0

        total = (
            base
            + ocr     * SCORE_WEIGHTS["ocr_overlap"]
            + edge    * SCORE_WEIGHTS["edge_density"]
            + writing * SCORE_WEIGHTS["active_writing"]
        )

        scores.append({
            "region":  region["name"],
            "total":   total,
            "base":    base,
            "ocr":     ocr,
            "edge":    edge,
            "writing": writing,
        })

    return scores


# ─────────────────────────────────────────────
# 8. AGGREGATE 3-FRAME SCORES (MAX)
# ─────────────────────────────────────────────

def entry_sample_times(fps, sub_start_sec, sub_end_sec):
    """(scoring sample times, writing-detector sample times) for one subtitle."""
    sample_times = [
        sub_start_sec + 0.1,
        (sub_start_sec + sub_end_sec) / 2,
        max(sub_start_sec + 0.1, sub_end_sec - 0.1),
    ]
    return sample_times, writing_sample_times(fps, sub_start_sec, sub_end_sec)


def score_subtitle_entry(analysis_frames, fps, sub_start_sec, sub_end_sec, prev_frame,
                         reader, mode: str = "fast",
                         timings: dict | None = None):
    """
    Sample 3 frames, score each, return per-region MAX score.
    Returns (region_scores_list, sampled_frames_list).

    `analysis_frames` is the {timestamp: 640x360 frame} dict already decoded
    for this entry (see entry_sample_times + FrameStream.frames_at), so no
    video I/O happens here.

    Active writing detection runs ONCE per entry (not per frame) via
    compute_active_writing(), then writing_scores are passed into each
    score_frame() call. This means writing detection is never subject to
    MAX aggregation — a single noisy frame cannot inflate the writing penalty.

    current_region_name removed (Phase 5) — switch_penalty deleted.
    """
    sample_times, _writing_times = entry_sample_times(fps, sub_start_sec, sub_end_sec)

    writing_start = time.perf_counter()
    writing_scores = compute_active_writing(
        None, fps, sub_start_sec, sub_end_sec, 0.0, analysis_frames
    )
    if timings is not None:
        timings["writing_seconds"] = timings.get("writing_seconds", 0.0) + (time.perf_counter() - writing_start)

    # Fast mode uses OCR at the midpoint only. Quality mode retains the old
    # three-frame OCR behaviour; both modes retain three-frame edge scoring.
    ocr_times = set(sample_times if mode == "quality" else [sample_times[1]])

    all_frame_scores = []
    frames = []

    for t in sample_times:
        frame = analysis_frames.get(t)
        if frame is None:
            continue
        frames.append(frame)
        prev = prev_frame if prev_frame is not None else frame
        frame_scores = score_frame(
            frame, prev, reader, writing_scores,
            run_ocr=(t in ocr_times), is_analysis_frame=True, timings=timings
        )
        all_frame_scores.append(frame_scores)

    if not all_frame_scores:
        return [{"region": r["name"], "total": r["base"], "ocr": 0, "edge": 0,
                 "writing": 0.0, "base": r["base"]} for r in REGIONS], frames

    # MAX across the 3 frames per region (ocr + edge vary per frame;
    # writing is constant across all 3 since it was computed once above)
    region_max = {}
    for frame_scores in all_frame_scores:
        for rs in frame_scores:
            name = rs["region"]
            if name not in region_max or rs["total"] > region_max[name]["total"]:
                region_max[name] = rs

    return list(region_max.values()), frames


# ─────────────────────────────────────────────
# 9. TEMPORAL SMOOTHING
# ─────────────────────────────────────────────

class TemporalSmoother:
    def __init__(self):
        self.current_region   = "bottom_center"
        self.current_score    = 0.0
        self.candidate_region = None
        self.candidate_score  = None
        self.candidate_since  = None

    def update(self, region_scores: list, sub_start_sec: float) -> str:
        """
        Apply hysteresis and dwell rules. Returns chosen region name.
        """
        # If bottom_center is perfectly clean (score == 1.0), immediately snap to it
        for rs in region_scores:
            if rs["region"] == "bottom_center" and rs["total"] == 1.0:
                self.current_region   = "bottom_center"
                self.current_score    = 1.0
                self.candidate_region = None
                self.candidate_since  = None
                return "bottom_center"

        adjusted = []
        for rs in region_scores:
            score = rs["total"]
            if rs["region"] == self.current_region:
                score -= HYSTERESIS_DISCOUNT
            adjusted.append((rs["region"], score))

        adjusted.sort(key=lambda x: x[1])
        best_name, best_score = adjusted[0]

        if best_name == self.current_region:
            self.candidate_region = None
            self.candidate_since  = None
            return self.current_region

        current_adj_score = next(s for n, s in adjusted if n == self.current_region)
        gap = current_adj_score - best_score

        if gap < SCORE_GAP_THRESHOLD:
            self.candidate_region = None
            self.candidate_since  = None
            return self.current_region

        if self.candidate_region != best_name:
            self.candidate_region = best_name
            self.candidate_score  = best_score
            self.candidate_since  = sub_start_sec

        dwell = sub_start_sec - self.candidate_since
        if dwell >= DWELL_MIN_SECONDS or gap >= 1.0:
            self.current_region   = best_name
            self.current_score    = best_score
            self.candidate_region = None
            self.candidate_since  = None

        return self.current_region

    def check_dwell(self, sub_start_sec: float) -> str:
        """
        Advance dwell timer without requiring new region scores.
        Called for short or similarity-skipped subtitles so a pending
        candidate can commit during skip chains.
        """
        if self.candidate_region is None:
            return self.current_region

        dwell = sub_start_sec - self.candidate_since
        if dwell >= DWELL_MIN_SECONDS:
            self.current_region   = self.candidate_region
            self.current_score    = self.candidate_score if self.candidate_score is not None else 0.0
            self.candidate_region = None
            self.candidate_since  = None

        return self.current_region


# ─────────────────────────────────────────────
# 10. SUBTITLE TEXT NORMALISATION & WRAPPING
# ─────────────────────────────────────────────

def wrap_subtitle_text(
    text: str,
    max_chars_per_line: int = WRAP_MAX_CHARS_PER_LINE,
    max_lines: int = WRAP_MAX_LINES,
) -> str:
    """
    Normalise and wrap a subtitle string.

    Steps
    -----
    1. Strip every existing line-break (\\n, \\r, VTT <br>, HTML <br />).
    2. Collapse runs of whitespace to a single space.
    3. Wrap at word boundaries so no line exceeds *max_chars_per_line*.
    4. Truncate to *max_lines* lines (never splits a word mid-token).

    Edge cases
    ----------
    * URLs / long tokens  — placed on their own line, allowed to overflow.
    * Mathematical / code — treated as plain tokens; no special handling.
    * Empty / whitespace-only input — returns an empty string.

    Parameters
    ----------
    text : str
        Raw subtitle text from SRT (may contain arbitrary line breaks).
    max_chars_per_line : int
        Character budget per line (default WRAP_MAX_CHARS_PER_LINE = 38).
    max_lines : int
        Maximum number of output lines (default WRAP_MAX_LINES = 2).

    Returns
    -------
    str
        Wrapped subtitle text with '\\n' separating lines.
    """
    # Remove SRT / VTT / HTML line-break markup
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    # Flatten line breaks and collapse whitespace
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return ""

    words = text.split(" ")
    lines: list[str] = []
    current_line = ""

    for word in words:
        if len(lines) == max_lines - 1:
            current_line = (current_line + " " + word).strip() if current_line else word
            continue

        if not current_line:
            current_line = word
        elif len(current_line) + 1 + len(word) <= max_chars_per_line:
            current_line += " " + word
        else:
            lines.append(current_line)
            if len(lines) == max_lines - 1:
                current_line = word
            else:
                current_line = word

    if current_line:
        lines.append(current_line)

    return "\n".join(lines)


# ─────────────────────────────────────────────
# 10b. VTT HELPERS
# ─────────────────────────────────────────────

# VTT cue positioning per region.
# The JS renderer in player.html parses the region: tag from each cue header
# and applies REGION_CUE_SETTINGS for pixel-accurate placement in all browsers.
# Inline line:/position: values are kept as a fallback for standard VTT players
# (VLC, direct Firefox use) where the JS renderer is not active.
REGION_VTT_ALIGN = {
    "bottom_center": "line:90% position:50% align:center region:bottom_center",
    "bottom_left":   "line:90% position:7%  align:left   region:bottom_left",
    "bottom_right":  "line:90% position:93% align:right  region:bottom_right",
    "middle_left":   "line:65% position:7%  align:left   region:middle_left",
    "middle_right":  "line:65% position:93% align:right  region:middle_right",
    "upper_left":    "line:47% position:7%  align:left   region:upper_left",
    "upper_right":   "line:47% position:93% align:right  region:upper_right",
    "top_center":    "line:25% position:50% align:center region:top_center",
}

# Baseline cues always sit at bottom-center.
BASELINE_VTT_POSITION = "line:90% position:50% align:center region:bottom_center"


def srt_time_to_vtt(srt_time) -> str:
    """Convert pysrt SubRipTime to VTT timestamp string."""
    h  = srt_time.hours
    m  = srt_time.minutes
    s  = srt_time.seconds
    ms = srt_time.milliseconds
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def build_vtt(entries: list, transition: str, adaptive: bool) -> str:
    """
    Build a WebVTT string.

    Each cue header carries both inline positioning (line:/position:) as a
    fallback for standard VTT players, and a region: tag that the JS renderer
    in player.html uses for pixel-accurate placement in all browsers.
    No REGION blocks are injected — they are unsupported in Chrome and
    unreliable in Firefox.
    """
    lines = ["WEBVTT", ""]

    style_block = (
        "STYLE\n"
        "::cue {\n"
        "  font-family: Arial, Liberation Sans, sans-serif;\n"
        "  font-size: 4.5vh;\n"
        "  color: white;\n"
        "  background-color: rgba(0, 0, 0, 0.75);\n"
        "  border-radius: 0.3vh;\n"
        "  padding: 0.5vh 1vh;\n"
        "  line-height: 1.3;\n"
        "}\n"
    )
    lines.append(style_block)

    for e in entries:
        start_str = srt_time_to_vtt(e["start"])
        end_str   = srt_time_to_vtt(e["end"])
        position  = REGION_VTT_ALIGN[e["region"]] if adaptive else BASELINE_VTT_POSITION

        # Safety net: wrap_subtitle_text is idempotent — if e["text"] is already
        # wrapped (normal pipeline flow) this is a no-op. Ensures correctness
        # when build_vtt() is called directly in tests or external scripts.
        cue_text = wrap_subtitle_text(
            e["text"],
            max_chars_per_line=REGION_WRAP_CHARS.get(e["region"], WRAP_MAX_CHARS_PER_LINE),
        )

        lines.append(f"{e['index']}")
        lines.append(f"{start_str} --> {end_str} {position}")
        lines.append(cue_text)
        lines.append("")

    return "\n".join(lines)


# ─────────────────────────────────────────────
# 11. METRICS
# ─────────────────────────────────────────────

def compute_metrics(entries: list, video_duration: float) -> dict:
    total = len(entries)
    if total == 0:
        return {}

    switches = sum(
        1 for i in range(1, total)
        if entries[i]["region"] != entries[i - 1]["region"]
    )
    duration_minutes = video_duration / 60.0
    switch_rate = switches / duration_minutes if duration_minutes > 0 else 0

    total_sub_duration = sum((e["end_sec"] - e["start_sec"]) for e in entries)
    avg_dwell = total_sub_duration / switches if switches > 0 else total_sub_duration

    region_counts = {}
    for e in entries:
        region_counts[e["region"]] = region_counts.get(e["region"], 0) + 1
    region_distribution = {k: round(v / total * 100, 1) for k, v in region_counts.items()}

    priority_map = {r["name"]: i for i, r in enumerate(REGIONS)}
    avg_displacement = sum(priority_map.get(e["region"], 0) for e in entries) / total

    return {
        "total_subtitles":        total,
        "total_switches":         switches,
        "switch_rate_per_min":    round(switch_rate, 3),
        "avg_dwell_seconds":      round(avg_dwell, 3),
        "region_distribution_pct": region_distribution,
        "displacement_score":     round(avg_displacement, 3),
    }


# ─────────────────────────────────────────────
# 12. DEBUG CSV
# ─────────────────────────────────────────────

def make_debug_row(idx, sub, chosen_region, region_scores, skipped, fallback, prev_region,
                   wrapped_text: str = "", similarity_skipped: bool = False):
    flags = []
    if skipped:
        flags.append("SKIPPED_SHORT")
    if similarity_skipped:
        flags.append("SIMILARITY_SKIP")
    if fallback:
        flags.append("FALLBACK_USED")
    if region_scores and all(s["total"] > 6.0 for s in region_scores):
        flags.append("ALL_HIGH_SCORES")

    row = {
        "index":        idx,
        "start":        str(sub.start),
        "end":          str(sub.end),
        "text_raw":     sub.text.replace("\n", "↵"),
        "text_wrapped": wrapped_text.replace("\n", "↵"),
        "line_count":   len(wrapped_text.split("\n")) if wrapped_text else 0,
        "word_count":   len(wrapped_text.split()) if wrapped_text else 0,
        "chosen_region": chosen_region,
        "prev_region":  prev_region,
        "flags":        "|".join(flags),
    }
    if region_scores:
        for rs in region_scores:
            row[f"score_{rs['region']}"] = round(rs["total"], 3)
            row[f"writing_{rs['region']}"] = round(rs.get("writing", 0.0), 2)
    return row


# ─────────────────────────────────────────────
# 13. MAIN PIPELINE
# ─────────────────────────────────────────────

def run_pipeline(video_id: str, transition: str, debug: bool, video_path: str = None,
                 subtitle_path: str = None, out_dir: str = None, mode: str = "fast",
                 gpu_decode: bool = True):
    t0 = time.time()
    ensure_dirs()
    if mode not in {"fast", "quality"}:
        raise ValueError("mode must be 'fast' or 'quality'")

    if video_path and subtitle_path:
        lecture_type = "custom"
        srt_path = subtitle_path
        # Get duration from OpenCV later
    else:
        meta          = load_video_meta(video_id)
        lecture_type  = meta["lecture_type"]
        video_path    = meta["path"]
        srt_path      = meta["srt_path"]
        video_duration = float(meta["duration_seconds"])

    print(f"[INFO] Video   : {video_path}")
    print(f"[INFO] SRT     : {srt_path}")
    print(f"[INFO] Type    : {lecture_type}")
    print(f"[INFO] Mode    : {mode} (OCR {'midpoint only' if mode == 'fast' else 'all 3 frames'})")

    subs = pysrt.open(srt_path)
    print(f"[INFO] Subtitles: {len(subs)} entries")

    # OpenCV is only used to read container properties; frames come from FrameStream.
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise IOError(f"Cannot open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if video_path and subtitle_path:
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        video_duration = frame_count / fps if fps > 0 else 0.0
    cap.release()

    start_time_offset = 0.0
    try:
        cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=start_time", "-of", "default=noprint_wrappers=1:nokey=1", video_path]
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8").strip()
        if out and out != "N/A":
            start_time_offset = float(out)
    except Exception as e:
        print(f"[WARN] Failed to read start_time for {video_path}: {e}")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    reader = setup_detectors(device)

    stream = FrameStream(video_path, fps, start_time_offset, use_gpu=gpu_decode)
    print(f"[INFO] Decoder : ffmpeg {'NVDEC (cuda)' if gpu_decode else 'CPU'} single-pass stream")

    smoother          = TemporalSmoother()
    entries_adaptive  = []
    entries_baseline  = []
    debug_rows        = []
    prev_frame        = None
    last_scored_frame = None
    timings = {
        "mode": mode, "ocr_calls": 0, "ocr_seconds": 0.0,
        "decode_seconds": 0.0, "writing_seconds": 0.0,
        "decoded_entries": 0, "scored_entries": 0, "scored_seconds": 0.0,
        "short_skipped": 0, "similarity_skipped": 0,
    }

    for i, sub in enumerate(subs):
        idx = i + 1
        start_sec = (sub.start.hours * 3600 + sub.start.minutes * 60
                     + sub.start.seconds + sub.start.milliseconds / 1000)
        end_sec   = (sub.end.hours * 3600 + sub.end.minutes * 60
                     + sub.end.seconds + sub.end.milliseconds / 1000)

        prev_region       = smoother.current_region
        skipped           = False
        fallback          = False
        similarity_skipped = False
        region_scores     = None

        # ── Normalise + wrap with global limit (word-count pass) ──────────
        wrapped_text = wrap_subtitle_text(sub.text)
        word_count   = len(wrapped_text.split())

        if word_count < SHORT_SUBTITLE_THRESHOLD:
            chosen_region = smoother.check_dwell(start_sec)
            skipped = True
            timings["short_skipped"] += 1
        else:
            # ── Decode every frame this entry needs in ONE forward pass ───
            sample_times, writing_times = entry_sample_times(fps, start_sec, end_sec)
            decode_start = time.perf_counter()
            analysis_frames = stream.frames_at([*sample_times, *writing_times])
            timings["decode_seconds"] += time.perf_counter() - decode_start
            timings["decoded_entries"] += 1

            # ── Similarity gate (probe = last sample frame, no extra seek) ─
            probe = analysis_frames.get(sample_times[2])
            if (last_scored_frame is not None and probe is not None
                    and frames_are_similar(probe, last_scored_frame)):
                chosen_region      = smoother.check_dwell(start_sec)
                similarity_skipped = True
                timings["similarity_skipped"] += 1

            if not similarity_skipped:
                try:
                    entry_start = time.perf_counter()
                    region_scores, sampled_frames = score_subtitle_entry(
                        analysis_frames, fps, start_sec, end_sec, prev_frame,
                        reader, mode, timings
                    )
                    timings["scored_entries"] += 1
                    timings["scored_seconds"] += time.perf_counter() - entry_start
                    if sampled_frames:
                        prev_frame        = sampled_frames[-1]
                        last_scored_frame = sampled_frames[-1]
                    chosen_region = smoother.update(region_scores, start_sec)
                except Exception as e:
                    print(f"[WARN] Entry {idx} scoring failed: {e} — using fallback")
                    chosen_region = smoother.current_region
                    fallback = True

        # ── Re-wrap using chosen region's horizontal char budget ──────────
        adaptive_chars = REGION_WRAP_CHARS.get(chosen_region, WRAP_MAX_CHARS_PER_LINE)
        final_text     = wrap_subtitle_text(sub.text, max_chars_per_line=adaptive_chars)
        baseline_text  = wrap_subtitle_text(sub.text, max_chars_per_line=REGION_WRAP_CHARS["bottom_center"])

        entry = {
            "index":     idx,
            "start":     sub.start,
            "end":       sub.end,
            "start_sec": start_sec,
            "end_sec":   end_sec,
            "text":      final_text,
            "region":    chosen_region,
        }
        entries_adaptive.append(entry)
        entries_baseline.append({
            **entry,
            "text":   baseline_text,
            "region": "bottom_center",
        })

        if debug:
            debug_rows.append(make_debug_row(
                idx, sub, chosen_region, region_scores, skipped, fallback, prev_region,
                wrapped_text=final_text,
                similarity_skipped=similarity_skipped,
            ))

        if (i + 1) % 10 == 0 or (i + 1) == len(subs):
            avg_entry = timings["scored_seconds"] / max(1, timings["scored_entries"])
            print(f"[INFO] Processed {i+1}/{len(subs)} subtitles | "
                  f"OCR calls={timings['ocr_calls']} | avg scored entry={avg_entry:.2f}s")

    timings["stream_restarts"] = stream.restarts
    timings["decoder"] = "ffmpeg-nvdec" if stream.use_gpu else "ffmpeg-cpu"
    stream.close()

    # ── Write VTT files ──
    if out_dir:
        out_dir_path = Path(out_dir)
    else:
        out_dir_path = Path(f"processed/{lecture_type}")
    out_dir_path.mkdir(parents=True, exist_ok=True)

    adaptive_vtt_path = out_dir_path / f"{video_id}_adaptive.vtt"
    baseline_vtt_path = out_dir_path / f"{video_id}_baseline.vtt"

    adaptive_vtt_path.write_text(build_vtt(entries_adaptive, transition, adaptive=True),  encoding="utf-8")
    baseline_vtt_path.write_text(build_vtt(entries_baseline, transition, adaptive=False), encoding="utf-8")
    print(f"[OUT] {adaptive_vtt_path}")
    print(f"[OUT] {baseline_vtt_path}")

    # ── Metrics ──
    metrics      = compute_metrics(entries_adaptive, video_duration)
    if out_dir:
        metrics_path = Path(out_dir) / f"{video_id}_metrics.json"
    else:
        metrics_path = Path(f"outputs/metrics/{video_id}_metrics.json")

    metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    print(f"[OUT] {metrics_path}")

    timings["total_seconds"] = round(time.time() - t0, 3)
    timing_path = out_dir_path / f"{video_id}_timing.json"
    timing_path.write_text(json.dumps(timings, indent=2), encoding="utf-8")
    print(f"[OUT] {timing_path}")

    # ── Debug CSV ──
    if debug and debug_rows:
        debug_path = Path(f"outputs/debug/{video_id}_debug.csv")
        all_keys   = set()
        for row in debug_rows:
            all_keys.update(row.keys())
        base_fields  = ["index", "start", "end", "text_raw", "text_wrapped",
                        "line_count", "word_count", "chosen_region", "prev_region", "flags"]
        score_fields = sorted([k for k in all_keys if k.startswith("score_")])
        fieldnames   = base_fields + score_fields

        with open(debug_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames,
                                    restval="", extrasaction="ignore")
            writer.writeheader()
            writer.writerows(debug_rows)
        print(f"[OUT] {debug_path}")

    elapsed = time.time() - t0
    print(f"[DONE] {video_id} completed in {elapsed:.1f}s")
    print(f"[METRICS] switches={metrics.get('total_switches', 0)}, "
          f"switch_rate={metrics.get('switch_rate_per_min', 0)}/min, "
          f"avg_dwell={metrics.get('avg_dwell_seconds', 0)}s, "
          f"displacement={metrics.get('displacement_score', 0)}")


# ─────────────────────────────────────────────
# 14. CLI
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Adaptive Subtitle Placement Pipeline")
    parser.add_argument("--video",      required=True,
                        help="Video ID from master.csv, e.g. coding_001")
    parser.add_argument("--video-path", help="Direct path to video file (overrides master.csv)")
    parser.add_argument("--subtitle-path", help="Direct path to subtitle file")
    parser.add_argument("--output-dir", help="Direct path to output directory")
    parser.add_argument("--cpu-decode", action="store_true",
                        help="Decode with ffmpeg on the CPU instead of NVDEC")
    parser.add_argument("--mode", default="fast", choices=["fast", "quality"],
                        help="fast: midpoint OCR; quality: OCR all three score frames")
    parser.add_argument("--transition", default="instant",
                        choices=["instant", "fade", "slide"],
                        help="Subtitle transition style (default: instant)")
    parser.add_argument("--debug",      action="store_true",
                        help="Write per-entry debug CSV to outputs/debug/")
    args = parser.parse_args()

    run_pipeline(
        video_id=args.video,
        transition=args.transition,
        debug=args.debug,
        video_path=args.video_path,
        subtitle_path=args.subtitle_path,
        out_dir=args.output_dir,
        mode=args.mode,
        gpu_decode=not args.cpu_decode,
    )


if __name__ == "__main__":
    main()