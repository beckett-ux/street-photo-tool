@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Resolve directory of this script
set "SCRIPT_DIR=%~dp0"
set "PATHS_FILE=%SCRIPT_DIR%paths.txt"

if not exist "%PATHS_FILE%" (
  echo Missing paths file: %PATHS_FILE%
  echo Please create it using the template in paths.txt.
  pause
  exit /b 1
)

REM Load key=value pairs from paths file
for /f "usebackq tokens=1* delims==" %%A in ("%PATHS_FILE%") do (
  set "key=%%A"
  set "value=%%B"
  if /I "!key!"=="PROJECT_ROOT" set "PROJECT_ROOT=!value!"
)

if not defined PROJECT_ROOT (
  echo PROJECT_ROOT is not set in %PATHS_FILE%.
  pause
  exit /b 1
)

cd /d "%PROJECT_ROOT%" || (
  echo Failed to cd into %PROJECT_ROOT%.
  pause
  exit /b 1
)

echo Stopping existing Node server if running...
taskkill /IM node.exe /F >nul 2>&1

echo Checking for local changes...
set "DIRTY="
for /f %%G in ('git status --porcelain') do (
  set "DIRTY=1"
  goto :dirty_done
)
:dirty_done

if defined DIRTY (
  echo Local changes detected. Stashing before update...
  git stash push -u -m "auto-stash before update"
  set "STASHED=1"
)

echo Pulling latest code from GitHub...
git pull

if defined STASHED (
  echo Restoring stashed changes...
  git stash pop
)

echo Installing any new dependencies...
npm install

echo Starting server...
start "" node server.js

echo Update complete.
pause
