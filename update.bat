@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PATHS_FILE=%SCRIPT_DIR%paths.txt"

if not exist "%PATHS_FILE%" (
  echo Missing paths file: %PATHS_FILE%
  pause
  exit /b 1
)

set "PROJECT_ROOT="
set "REPO_URL="
for /f "usebackq tokens=1* delims==" %%A in ("%PATHS_FILE%") do (
  if /I "%%A"=="PROJECT_ROOT" set "PROJECT_ROOT=%%B"
  if /I "%%A"=="REPO_URL" set "REPO_URL=%%B"
)

if not defined REPO_URL (
  set "REPO_URL=https://github.com/beckett-ux/street-photo-tool"
)

if not defined PROJECT_ROOT (
  echo PROJECT_ROOT is not set in %PATHS_FILE%.
  pause
  exit /b 1
)

if not exist "%PROJECT_ROOT%" (
  echo PROJECT_ROOT does not exist: %PROJECT_ROOT%
  pause
  exit /b 1
)

cd /d "%PROJECT_ROOT%" || (
  echo Failed to cd into %PROJECT_ROOT%.
  pause
  exit /b 1
)

echo Updating from GitHub...

if not exist ".git" (
  echo .git not found in %PROJECT_ROOT%.
  echo This updater only works inside a git clone. Please clone:
  echo %REPO_URL%
  pause
  exit /b 1
)

set "PATHS_BACKUP=%PROJECT_ROOT%\\paths.txt.localbackup"
if exist "paths.txt" (
  copy /y "paths.txt" "%PATHS_BACKUP%" >nul
)

set "DIRTY="
for /f %%G in ('git status --porcelain') do (
  set "DIRTY=1"
  goto :dirty_done
)
:dirty_done

if defined DIRTY (
  echo Local changes detected. Stashing before update...
  git stash push -u -m "auto-stash before update"
  if not "%errorlevel%"=="0" (
    echo Failed to stash local changes.
    if exist "%PATHS_BACKUP%" copy /y "%PATHS_BACKUP%" "paths.txt" >nul
    pause
    exit /b 1
  )
  set "STASHED=1"
)

git pull --ff-only
if not "%errorlevel%"=="0" (
  echo Failed to pull latest changes.
  if exist "%PATHS_BACKUP%" copy /y "%PATHS_BACKUP%" "paths.txt" >nul
  pause
  exit /b 1
)

if defined STASHED (
  echo Restoring local changes...
  git stash pop
)

if exist "%PATHS_BACKUP%" (
  copy /y "%PATHS_BACKUP%" "paths.txt" >nul
  del /f /q "%PATHS_BACKUP%" >nul 2>&1
)

echo Update complete.
pause
