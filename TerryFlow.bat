@echo off
cd /d "%~dp0"
title Terry Flow - update, check environment, start
set "PYTHONUTF8=1"

REM ================= 1/3  pull updates (skipped quietly when git is not available) =================
echo [1/3] Checking for updates ...
where git >nul 2>&1
if errorlevel 1 goto noGit
if not exist ".git" goto noGit
git -c safe.directory="%CD%" pull --ff-only
if errorlevel 1 echo [warn] Update failed ^(network, local changes, or git access^). Continuing with the current version.
goto envCheck
:noGit
echo [skip] git was not found or this is not a git checkout.

REM ================= 2/3  deploy / check the environment (every step is skipped when already done) =================
:envCheck
echo [2/3] Checking the environment ...
if not exist "venv\Scripts\python.exe" (
    echo [setup] creating the Python virtual environment in venv ...
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
)

REM install whatever packages the venv is missing (new versions may add some)
"venv\Scripts\python.exe" -c "import fastapi,uvicorn,httpx,PIL,customtkinter" >nul 2>&1
if errorlevel 1 (
    echo [setup] installing Python packages ...
    "venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
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

REM ================= 3/3  start the console (no black window stays open) =================
echo [3/3] Starting Terry Flow ...
start "" "venv\Scripts\pythonw.exe" "TerryFlow.pyw"
timeout /t 2 /nobreak >nul
exit /b 0
