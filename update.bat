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
  call :fail "PROJECT_ROOT is not set in %PATHS_FILE%"
)

if not exist "%PROJECT_ROOT%" (
  call :fail "PROJECT_ROOT does not exist: %PROJECT_ROOT%"
)

if not exist "%PROJECT_ROOT%" (
  echo PROJECT_ROOT does not exist: %PROJECT_ROOT%
  pause
  exit /b 1
)

if not exist "%PROJECT_ROOT%" (
  echo PROJECT_ROOT does not exist: %PROJECT_ROOT%
  pause
  exit /b 1
)

cd /d "%PROJECT_ROOT%" || (
  call :fail "Failed to cd into %PROJECT_ROOT%"
)

echo Updating from GitHub...

if not exist ".git" (
  if not defined REPO_URL (
    echo .git not found in %PROJECT_ROOT%.
    echo Please add REPO_URL=... to %PATHS_FILE% so this script can clone the repo.
    pause
    exit /b 1
  )
  echo No git repo found. Re-cloning from %REPO_URL%...
  cd /d "%SCRIPT_DIR%" || (
    echo Failed to cd into %SCRIPT_DIR%.
    pause
    exit /b 1
  )
  rd /s /q "%PROJECT_ROOT%"
  git clone "%REPO_URL%" "%PROJECT_ROOT%"
  if not "%errorlevel%"=="0" (
    echo Failed to clone repository.
    pause
    exit /b 1
  )
  echo Update complete.
  pause
  exit /b 0
)

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
exit /b 0

:fail
  echo.
  echo ERROR: %~1
  echo.
  pause
  exit /b 1
