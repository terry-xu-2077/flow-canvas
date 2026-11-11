@echo off
cd /d "%~dp0"
title Flow Canvas
set "PYTHONUNBUFFERED=1"
:loop
echo.
echo [%date% %time%] starting Flow Canvas on the port in config.json ...
".\venv\Scripts\python.exe" -m server.main
echo [%date% %time%] exited (code %errorlevel%), restarting in 5s ... Ctrl+C to stop
ping -n 6 127.0.0.1 >nul 2>&1
goto loop
