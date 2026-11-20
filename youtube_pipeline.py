"""
youtube_pipeline.py — End-to-End YouTube Adaptive Subtitle Pipeline

Fetches a YouTube video by URL, retrieves or transcribes subtitles with Whisper,
and runs the Adaptive Captioning placement engine.

Workflow:
  1. Extract YouTube metadata (title, author, duration, id).
  2. Try to fetch existing YouTube subtitles (manual or auto-generated English).
  3. If no subtitles are available:
       - Download lightweight audio track (~10-20 MB).
       - Transcribe with OpenAI Whisper on GPU into SRT format.
  4. Fetch lightweight video (360p) for fast local frame analysis.
  5. Run AdaptiveCaptioning pipeline.py to generate intelligent WebVTT subtitle positions.

Usage:
  python youtube_pipeline.py --url "https://www.youtube.com/watch?v=VIDEO_ID"
  python youtube_pipeline.py --url "https://youtu.be/VIDEO_ID" --mode fast
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import yt_dlp


def sanitize_filename(name: str) -> str:
    return re.sub(r'[\\/*?:"<>| ]', "_", name)


def extract_video_id(url: str) -> str:
    """Extract 11-char YouTube ID from various URL formats."""
    patterns = [
        r'(?:v=|\/)([0-9A-Za-z_-]{11}).*',
        r'youtu\.be\/([0-9A-Za-z_-]{11})',
        r'embed\/([0-9A-Za-z_-]{11})',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return "yt_video_" + str(int(time.time()))


def format_timestamp_srt(seconds: float) -> str:
    """Convert float seconds into SRT timestamp: HH:MM:SS,mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        millis = 999
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def get_youtube_info(url: str) -> dict:
    """Extract video metadata without downloading any media."""
    ydl_opts = {
        'skip_download': True,
        'quiet': True,
        'no_warnings': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "id": info.get("id"),
            "title": info.get("title", "Unknown Title"),
            "uploader": info.get("uploader", "Unknown Channel"),
            "duration": info.get("duration", 0),
            "subtitles": info.get("subtitles", {}),
            "automatic_captions": info.get("automatic_captions", {}),
        }


def fetch_youtube_subtitles(url: str, output_dir: Path, video_id: str) -> Path | None:
    """Attempt to download existing manual or automatic English subtitles as SRT."""
    srt_out_pattern = output_dir / f"{video_id}.%(ext)s"

    ydl_opts = {
        'skip_download': True,
        'writesub': True,
        'writeautomaticsub': True,
        'subtitleslangs': ['en.*', 'en'],
        'subtitlesformat': 'srt/vtt/best',
        'outtmpl': str(srt_out_pattern),
        'quiet': True,
        'no_warnings': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        # Find downloaded subtitle
        for f in output_dir.glob(f"{video_id}*.srt"):
            return f
        for f in output_dir.glob(f"{video_id}*.vtt"):
            # Convert VTT to clean SRT
            srt_converted = output_dir / f"{video_id}.srt"
            vtt_to_srt(f, srt_converted)
            return srt_converted
    except Exception as e:
        print(f"[WARN] Could not fetch native YouTube subtitles: {e}")

    return None


def vtt_to_srt(vtt_path: Path, srt_path: Path):
    """Convert WebVTT text file to SRT format."""
    lines = vtt_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    out = []
    cue_idx = 1
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if "-->" in line:
            parts = line.split("-->")
            start = parts[0].strip().replace(".", ",")[:12]
            end = parts[1].strip().split()[0].replace(".", ",")[:12]
            # Ensure HH:MM:SS format
            if start.count(":") == 1:
                start = "00:" + start
            if end.count(":") == 1:
                end = "00:" + end

            i += 1
            text_lines = []
            while i < len(lines) and lines[i].strip() != "":
                clean = re.sub(r'<[^>]+>', '', lines[i].strip())
                if clean:
                    text_lines.append(clean)
                i += 1

            if text_lines:
                out.append(f"{cue_idx}\n{start} --> {end}\n" + "\n".join(text_lines) + "\n")
                cue_idx += 1
        i += 1

    srt_path.write_text("\n".join(out), encoding="utf-8")


def generate_subtitles_whisper(url: str, output_dir: Path, video_id: str, model_name: str = "base") -> Path:
    """Download audio track and transcribe with Whisper on GPU."""
    import whisper

    audio_path = output_dir / f"{video_id}_audio.m4a"
    srt_path = output_dir / f"{video_id}.srt"

    print(f"[1/3] Downloading audio-only stream (~15 MB)...")
    ydl_opts = {
        'format': 'ba[abr<=64]/ba/b',
        'outtmpl': str(audio_path),
        'quiet': True,
        'no_warnings': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[2/3] Transcribing audio with Whisper ('{model_name}' on {device.upper()})...")
    
    t_whisper_0 = time.time()
    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(str(audio_path), language="en", fp16=(device == "cuda"))
    whisper_duration = time.time() - t_whisper_0
    print(f"[INFO] Transcription complete in {whisper_duration:.1f}s.")

    # Write SRT
    srt_entries = []
    for idx, seg in enumerate(result.get("segments", []), start=1):
        start = format_timestamp_srt(seg["start"])
        end = format_timestamp_srt(seg["end"])
        text = seg["text"].strip()
        if text:
            srt_entries.append(f"{idx}\n{start} --> {end}\n{text}\n")

    srt_path.write_text("\n".join(srt_entries), encoding="utf-8")
    print(f"[OUT] Subtitle file generated: {srt_path}")

    # Remove temporary audio file to save disk space
    if audio_path.exists():
        try:
            audio_path.unlink()
        except OSError:
            pass

    return srt_path


def download_analysis_video(url: str, output_dir: Path, video_id: str) -> Path:
    """Download lightweight 360p video for local OCR/edge analysis."""
    video_out = output_dir / f"{video_id}_360p.mp4"
    if video_out.exists():
        print(f"[INFO] Analysis video already cached: {video_out}")
        return video_out

    print(f"[INFO] Downloading lightweight 360p stream for frame analysis...")
    ydl_opts = {
        'format': 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[ext=mp4]/best',
        'outtmpl': str(video_out),
        'quiet': False,
        'no_warnings': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    return video_out


def run_youtube_pipeline(url: str,
                         output_dir: str | None = None,
                         mode: str = "fast",
                         transition: str = "instant",
                         whisper_model: str = "base",
                         keep_video: bool = True):
    """Full execution pipeline for a YouTube video."""
    print("=" * 60)
    print("YOUTUBE ADAPTIVE SUBTITLE PIPELINE")
    print("=" * 60)

    video_id = extract_video_id(url)
    print(f"[INFO] YouTube ID: {video_id}")
    print(f"[INFO] URL       : {url}")

    if not output_dir:
        out_path = Path("processed/youtube") / video_id
    else:
        out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    # 1. Fetch info
    print("[Step 1/4] Fetching video information...")
    try:
        info = get_youtube_info(url)
        print(f"[INFO] Title   : {info['title']}")
        print(f"[INFO] Channel : {info['uploader']}")
        print(f"[INFO] Duration: {info['duration']}s")
    except Exception as e:
        print(f"[WARN] Metadata extraction error: {e}")
        info = {"id": video_id, "title": "YouTube Video", "uploader": "Unknown", "duration": 0}

    # 2. Subtitles: YouTube auto/manual -> fallback to Whisper
    print("\n[Step 2/4] Obtaining subtitles...")
    srt_file = fetch_youtube_subtitles(url, out_path, video_id)
    if srt_file and srt_file.exists() and srt_file.stat().st_size > 100:
        print(f"[SUCCESS] Native YouTube subtitles acquired: {srt_file}")
    else:
        print("[INFO] No suitable YouTube captions found. Activating Whisper ASR fallback...")
        srt_file = generate_subtitles_whisper(url, out_path, video_id, model_name=whisper_model)

    # 3. Video for analysis (360p)
    print("\n[Step 3/4] Preparing video for frame analysis...")
    video_file = download_analysis_video(url, out_path, video_id)

    # 4. Run Adaptive Captioning Placement Engine
    print("\n[Step 4/4] Running Adaptive Placement Engine...")
    from pipeline import run_pipeline
    t_start = time.time()
    run_pipeline(
        video_id=video_id,
        transition=transition,
        debug=False,
        video_path=str(video_file),
        subtitle_path=str(srt_file),
        out_dir=str(out_path),
        mode=mode,
        gpu_decode=True,
    )
    total_time = time.time() - t_start

    # Clean up video if requested
    if not keep_video and video_file.exists():
        video_file.unlink()

    # Write summary info
    manifest = {
        "youtube_id": video_id,
        "title": info["title"],
        "channel": info["uploader"],
        "duration_seconds": info["duration"],
        "adaptive_vtt": str(out_path / f"{video_id}_adaptive.vtt"),
        "baseline_vtt": str(out_path / f"{video_id}_baseline.vtt"),
        "metrics_json": str(out_path / f"{video_id}_metrics.json"),
        "timing_json": str(out_path / f"{video_id}_timing.json"),
        "embed_url": f"https://www.youtube.com/embed/{video_id}?enablejsapi=1",
    }
    manifest_path = out_path / "youtube_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\n" + "=" * 60)
    print("PIPELINE COMPLETED SUCCESSFULLY!")
    print(f"Adaptive VTT : {manifest['adaptive_vtt']}")
    print(f"Manifest     : {manifest_path}")
    print(f"Total Time   : {total_time:.2f}s")
    print("=" * 60)
    return manifest


def main():
    parser = argparse.ArgumentParser(description="YouTube Adaptive Subtitle Placement Pipeline")
    parser.add_argument("--url", required=True, help="YouTube video URL or ID")
    parser.add_argument("--output-dir", help="Custom output directory")
    parser.add_argument("--mode", default="fast", choices=["fast", "quality"],
                        help="fast: midpoint OCR; quality: OCR all three frames")
    parser.add_argument("--transition", default="instant", choices=["instant", "fade", "slide"])
    parser.add_argument("--whisper-model", default="base", choices=["tiny", "base", "small", "medium"])
    parser.add_argument("--delete-video-after", action="store_true",
                        help="Delete the 360p analysis video after computing WebVTT")
    args = parser.parse_args()

    run_youtube_pipeline(
        url=args.url,
        output_dir=args.output_dir,
        mode=args.mode,
        transition=args.transition,
        whisper_model=args.whisper_model,
        keep_video=not args.delete_video_after
    )


if __name__ == "__main__":
    main()
