@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo.
echo === Street Photo Tool Update ===
echo.

set "SCRIPT_DIR=%~dp0"
set "PATHS_FILE=%SCRIPT_DIR%paths.txt"

if not exist "%PATHS_FILE%" (
  call :fail "Missing paths file: %PATHS_FILE%"
)

set "PROJECT_ROOT="
for /f "usebackq tokens=1* delims==" %%A in ("%PATHS_FILE%") do (
  if /I "%%A"=="PROJECT_ROOT" set "PROJECT_ROOT=%%B"
)

if not defined PROJECT_ROOT (
  call :fail "PROJECT_ROOT is not set in %PATHS_FILE%"
)

if not exist "%PROJECT_ROOT%" (
  call :fail "PROJECT_ROOT does not exist: %PROJECT_ROOT%"
)

cd /d "%PROJECT_ROOT%" || (
  call :fail "Failed to cd into %PROJECT_ROOT%"
)

echo Using PROJECT_ROOT: %PROJECT_ROOT%

echo Stopping existing Node server if running...
taskkill /IM node.exe /F >nul 2>&1

echo Checking git repository...
if exist ".git" (
  where git >nul 2>&1
  if "%errorlevel%"=="0" (
    echo Pulling latest code from GitHub...
    git pull
  ) else (
    echo Git not found in PATH. Skipping git update.
  )
) else (
  echo .git not found. Skipping git update.
)

where npm >nul 2>&1
if not "%errorlevel%"=="0" (
  call :fail "npm is not available in PATH. Please install Node.js."
)

where node >nul 2>&1
if not "%errorlevel%"=="0" (
  call :fail "node is not available in PATH. Please install Node.js."
)

if not exist "package.json" (
  call :fail "package.json not found in %PROJECT_ROOT%. Check PROJECT_ROOT in paths.txt."
)

echo Node version:
node --version
echo npm version:
npm --version

if exist "node_modules" (
  echo node_modules already exists. Skipping npm install.
) else (
  echo Installing dependencies (first run may take a few minutes)...
  echo If this appears idle, npm may still be working. Press Ctrl+C to cancel.
  set "NPM_CONFIG_PROGRESS=true"
  call npm install --no-audit --no-fund --loglevel=info
  if not "%errorlevel%"=="0" (
    call :fail "npm install failed. See errors above."
  )
)

echo Dependencies installed successfully.
echo.
echo Starting server in this window...
echo Press Ctrl+C to stop the server.
echo.
node server.js

echo.
echo Server stopped.
pause
exit /b 0

:fail
  echo.
  echo ERROR: %~1
  echo.
  pause
  exit /b 1
