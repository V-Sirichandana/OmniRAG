import os, subprocess, sys, time, webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BE, FE = ROOT / "backend", ROOT / "frontend"

def py(folder):
    exe = folder / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return str(exe) if exe.exists() else sys.executable

procs = []
try:
    procs.append(subprocess.Popen([py(BE), "-m", "uvicorn", "app.main:app", "--port", "8000"], cwd=BE))
    time.sleep(6)
    procs.append(subprocess.Popen([py(FE), "-m", "streamlit", "run", "app.py", "--server.port", "8501", "--server.headless", "true"], cwd=FE))
    time.sleep(4)
    print("\nBackend : http://localhost:8000/docs\nWebsite : http://localhost:8501\nPress Ctrl+C to stop both.\n")
    webbrowser.open("http://localhost:8501")
    while all(p.poll() is None for p in procs):
        time.sleep(1)
    print("A server stopped - see the error above.")
except KeyboardInterrupt:
    pass
finally:
    for p in procs:
        if p.poll() is None:
            p.terminate()