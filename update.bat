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
for /f "usebackq tokens=1* delims==" %%A in ("%PATHS_FILE%") do (
  if /I "%%A"=="PROJECT_ROOT" set "PROJECT_ROOT=%%B"
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

git reset --hard
if not "%errorlevel%"=="0" (
  echo Failed to reset local changes.
  pause
  exit /b 1
)

git clean -fd
if not "%errorlevel%"=="0" (
  echo Failed to clean untracked files.
  pause
  exit /b 1
)

git pull
if not "%errorlevel%"=="0" (
  echo Failed to pull latest changes.
  pause
  exit /b 1
)

echo Update complete.
pause
