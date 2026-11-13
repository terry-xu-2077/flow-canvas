@echo off
cd /d "%~dp0"
title Flow Canvas
set "PYTHONUNBUFFERED=1"

REM ---------- first-run setup (safe to re-run; each step is skipped when already done) ----------
if not exist "venv\Scripts\python.exe" (
    echo [setup] creating Python virtual environment in venv ...
    where py >nul 2>&1
    if not errorlevel 1 (
        py -3 -m venv venv
    ) else (
        python -m venv venv
    )
    if not exist "venv\Scripts\python.exe" (
        echo [error] Python 3.10+ was not found. Install it from https://www.python.org and tick "Add python.exe to PATH", then run this again.
        pause
        exit /b 1
    )
    echo [setup] installing Python packages ...
    "venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [error] pip install failed. Check the network, then run this again.
        rmdir /s /q venv
        pause
        exit /b 1
    )
)

REM packages added by later versions: install whatever the existing venv is missing
"venv\Scripts\python.exe" -c "import fastapi,uvicorn,httpx,PIL,customtkinter" >nul 2>&1
if errorlevel 1 (
    echo [setup] installing missing Python packages ...
    "venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [error] pip install failed. Check the network, then run this again.
        pause
        exit /b 1
    )
)

if not exist "config.json" (
    echo [setup] config.json not found, creating it from config.example.json
    copy /y config.example.json config.json >nul
    echo.
    echo Edit config.json now: set flow_base_url and flow_api_key to your flow2api server, then save and close it.
    notepad config.json
)

if not exist "web\dist\index.html" (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo [error] web\dist is missing and Node.js was not found. Install Node.js LTS from https://nodejs.org, or copy a built web\dist folder here, then run this again.
        pause
        exit /b 1
    )
    echo [setup] building the web UI ^(first time only, takes a minute^) ...
    pushd web
    call npm install
    call npm run build
    popd
    if not exist "web\dist\index.html" (
        echo [error] web UI build failed, see the messages above.
        pause
        exit /b 1
    )
)

REM ---------- run: the console window starts the web service; no black window stays open ----------
start "" "venv\Scripts\pythonw.exe" "TerryFlow.pyw"
exit /b 0
