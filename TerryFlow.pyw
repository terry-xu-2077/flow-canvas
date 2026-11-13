r"""Starts the Terry Flow console without a black console window (double-click, or started by TerryFlow.bat).

Always runs inside the project's venv: when launched by the system Python (double-click on a .pyw) it hands over to
venv\Scripts\pythonw.exe. Crashes are written to logs\console_crash.log because there is no window to show them.
"""
import os
import subprocess
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
(ROOT / "logs").mkdir(exist_ok=True)

venv_py = ROOT / "venv" / "Scripts" / "pythonw.exe"
if venv_py.exists() and Path(sys.prefix).resolve() != (ROOT / "venv").resolve():
    subprocess.Popen([str(venv_py), str(Path(__file__).resolve())], cwd=ROOT, creationflags=0x08000000)  # no window
    sys.exit(0)

if sys.stdout is None:   # pythonw has no stdout/stderr; libraries that print would crash on None
    sys.stdout = sys.stderr = open(ROOT / "logs" / "console_stdout.log", "a", encoding="utf-8", buffering=1)

sys.path.insert(0, str(ROOT))
try:
    from server.console import main
    main()
except BaseException:
    (ROOT / "logs" / "console_crash.log").write_text(traceback.format_exc(), encoding="utf-8")
    raise
