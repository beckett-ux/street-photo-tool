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

set "URL=http://localhost:3000"

echo Installing dependencies...
npm install

echo Starting Street Commerce Photo Tool server...

REM Open Chrome in a new fullscreen window pointed at the tool
where chrome >nul 2>&1
if %errorlevel%==0 (
  echo Opening Chrome in fullscreen...
  start "" chrome --new-window --start-fullscreen "%URL%"
) else (
  echo Chrome not found in PATH. Opening default browser instead...
  start "" "%URL%"
)

REM Run the Node server in this console so you can see logs
node server.js

echo.
echo Server stopped. Press any key to close.
pause >nul
