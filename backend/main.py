"""
backend/main.py — AdaptiveCaptions FastAPI backend scaffold

Wraps pipeline.py as a subprocess. Provides:
  GET  /health
  POST /process       — upload video (+ optional VTT), start pipeline job
  GET  /status/{id}   — poll job status
  GET  /result/{id}   — get output file URLs once done

Run:
  cd AdaptiveCaptioning/backend
  uvicorn main:app --reload --port 8000
"""

import os, sys, uuid, shutil, subprocess
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

ROOT     = Path(__file__).parent.parent   # AdaptiveCaptioning/
PIPELINE = ROOT / "pipeline.py"
UPLOADS  = Path(__file__).parent / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)

def python_311() -> str:
    """Use the backend interpreter when it is 3.11; otherwise find Python 3.11."""
    if sys.version_info[:2] == (3, 11):
        return sys.executable
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python311" / "python.exe"
    if candidate.exists():
        return str(candidate)
    raise RuntimeError("Python 3.11 was not found. Install it or start the backend with Python 3.11.")

PYTHON_311 = python_311()

JOBS: dict[str, dict] = {}

def _clear_uploads():
    """Delete all job sub-folders inside uploads/ on startup."""
    for item in UPLOADS.iterdir():
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
            print(f"[startup] cleared {item.name}")
    JOBS.clear()
    print("[startup] uploads cleared, job store reset.")

@asynccontextmanager
async def lifespan(app):
    _clear_uploads()      # ← runs on every server start / restart
    yield                 # ← server is running
    # (shutdown code would go here if needed)

app = FastAPI(title="AdaptiveCaptions API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173", "http://localhost:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# Serve uploaded files (videos + VTT) directly from the backend
app.mount("/uploads", StaticFiles(directory=str(UPLOADS)), name="uploads")

@app.get("/health")
def health():
    return {"status": "ok", "pipeline": str(PIPELINE.exists())}

@app.post("/process")
async def process(
    background_tasks: BackgroundTasks,
    video: UploadFile = File(...),
    subtitle: Optional[UploadFile] = File(None),
):
    job_id   = str(uuid.uuid4())[:8]
    video_id = Path(video.filename).stem
    job_dir  = UPLOADS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    video_path = job_dir / video.filename
    with open(video_path, "wb") as f:
        shutil.copyfileobj(video.file, f)

    srt_path = None
    if subtitle and subtitle.filename:
        srt_path = job_dir / subtitle.filename
        with open(srt_path, "wb") as f:
            shutil.copyfileobj(subtitle.file, f)

    JOBS[job_id] = {
        "status": "queued", "video_id": video_id, "message": "Job queued",
        "video_path": str(video_path), "srt_path": str(srt_path) if srt_path else None,
    }
    background_tasks.add_task(_run_job, job_id, video_id, video_path, srt_path)
    return {"job_id": job_id, "video_id": video_id}

@app.get("/status/{job_id}")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job: raise HTTPException(404, "Job not found")
    return {"job_id": job_id, "status": job["status"], "message": job.get("message","")}

@app.get("/result/{job_id}")
def result(job_id: str):
    job = JOBS.get(job_id)
    if not job: raise HTTPException(404, "Job not found")
    if job["status"] != "done": raise HTTPException(400, f"Not done: {job['status']}")
    video_id = job["video_id"]
    base = "http://localhost:8000"
    job_dir = UPLOADS / job_id
    adaptive = job_dir / f"{video_id}_adaptive.vtt"
    if adaptive.exists():
        return {
            "video_url":        f"{base}/uploads/{job_id}/{Path(job['video_path']).name}",
            "adaptive_vtt_url": f"{base}/uploads/{job_id}/{video_id}_adaptive.vtt",
            "baseline_vtt_url": f"{base}/uploads/{job_id}/{video_id}_baseline.vtt",
            "metrics_url":      f"{base}/uploads/{job_id}/{video_id}_metrics.json",
            "timing_url":       f"{base}/uploads/{job_id}/{video_id}_timing.json",
        }

    for lt in ["coding", "ppt", "smartboard"]:
        adaptive = ROOT / "processed" / lt / f"{video_id}_adaptive.vtt"
        if adaptive.exists():
            return {
                "video_url":        f"{base}/uploads/{job_id}/{Path(job['video_path']).name}",
                "adaptive_vtt_url": f"{base}/processed/{lt}/{video_id}_adaptive.vtt",
                "baseline_vtt_url": f"{base}/processed/{lt}/{video_id}_baseline.vtt",
                "metrics_url":      f"{base}/outputs/metrics/{video_id}_metrics.json",
            }
    raise HTTPException(500, "Output files not found")

def _run_with_progress(command: list[str], job: dict, log_path: Path, prefix: str) -> tuple[int, str]:
    """Persist child output and surface its latest progress line to /status."""
    tail = deque(maxlen=20)
    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            command, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            log_file.write(line)
            log_file.flush()
            message = line.strip()
            if message:
                tail.append(message)
                job["message"] = f"{prefix}: {message}"
        return_code = process.wait()
    return return_code, "\n".join(tail)

def _run_job(job_id, video_id, video_path, srt_path):
    job = JOBS[job_id]
    job_dir = Path(video_path).parent

    if not srt_path:
        job.update({"status": "processing", "message": "Extracting audio & running Whisper transcription..."})
        gen_script = ROOT / "generate_subtitles.py"
        srt_path = str(job_dir / f"{video_id}_baseline.vtt")
        try:
            code, output = _run_with_progress(
                [PYTHON_311, "-u", str(gen_script), "--video", str(video_path), "--output", str(srt_path)],
                job, job_dir / "transcription.log", "Transcribing"
            )
            if code != 0:
                job.update({"status": "error", "message": "Transcription failed: " + output[-500:]})
                return
        except Exception as e:
            job.update({"status": "error", "message": f"Transcription err: {e}"})
            return

    job.update({"status": "processing", "message": "Pipeline running..."})
    try:
        code, output = _run_with_progress(
            [PYTHON_311, "-u", str(PIPELINE), "--video", video_id,
             "--video-path", str(video_path), "--subtitle-path", str(srt_path), 
             "--output-dir", str(job_dir), "--transition", "instant", "--mode", "fast"],
            job, job_dir / "pipeline.log", "Pipeline"
        )
        if code == 0:
            job.update({"status": "done", "message": "Pipeline completed"})
        else:
            job.update({"status": "error", "message": output[-500:] or "Pipeline error"})
    except subprocess.TimeoutExpired:
        job.update({"status": "error", "message": "Pipeline timed out"})
    except Exception as e:
        job.update({"status": "error", "message": str(e)})
