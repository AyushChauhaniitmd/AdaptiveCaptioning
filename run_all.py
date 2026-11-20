import subprocess
import sys
import time
import os
from pathlib import Path

def python_311():
    if sys.version_info[:2] == (3, 11):
        return sys.executable
    candidate = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Python" / "Python311" / "python.exe"
    if candidate.exists():
        return str(candidate)
    raise RuntimeError("Python 3.11 was not found. Install it or run this script with Python 3.11.")

def main():
    python_exe = python_311()
    root_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(root_dir, "frontend")
    backend_dir = os.path.join(root_dir, "backend")

    print("==================================================")
    print("Starting AdaptiveCaptioning Stack...")
    print("==================================================")

    # 1. Start Nexus Demo Server (serve.py)
    print("[1/3] Starting Nexus Demo Server (serve.py on port 8001)...")
    serve_process = subprocess.Popen(
        [python_exe, "serve.py"],
        cwd=root_dir
    )

    # 2. Start Backend API Server (FastAPI)
    print("[2/3] Starting Backend API (FastAPI on port 8000)...")
    backend_process = subprocess.Popen(
        [python_exe, "-m", "uvicorn", "main:app", "--reload", "--port", "8000"],
        cwd=backend_dir
    )

    # 3. Start Frontend UI Server (React/Vite)
    print("[3/3] Starting Frontend UI (Vite on port 5173)...")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    frontend_process = subprocess.Popen(
        [npm_cmd, "run", "dev"],
        cwd=frontend_dir
    )

    processes = [
        ("Serve.py", serve_process),
        ("Backend", backend_process),
        ("Frontend", frontend_process)
    ]

    print("\n==================================================")
    print("All servers are starting up! Press CTRL+C to stop all.")
    print("==================================================\n")

    try:
        # Keep the script running and monitor processes
        while True:
            time.sleep(1)
            for name, p in processes:
                if p.poll() is not None:
                    print(f"\n[!] {name} server exited unexpectedly with code {p.returncode}.")
                    raise KeyboardInterrupt

    except KeyboardInterrupt:
        print("\n==================================================")
        print("Shutting down all servers...")
        
        # Terminate all running processes
        for name, p in processes:
            if p.poll() is None:
                print(f"Terminating {name}...")
                p.terminate()
        
        # Wait for them to close
        for name, p in processes:
            p.wait()
            
        print("All servers stopped cleanly. Goodbye!")
        print("==================================================")

if __name__ == "__main__":
    main()
