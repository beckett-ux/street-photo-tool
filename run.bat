@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PATHS_FILE=%SCRIPT_DIR%paths.txt"

if not exist "%PATHS_FILE%" (
  echo ERROR: paths.txt not found in %SCRIPT_DIR%.
  exit /b 1
)

call :load_paths "%PATHS_FILE%"

if not defined PROJECT_ROOT (
  echo ERROR: PROJECT_ROOT is not set in paths.txt.
  exit /b 1
)

set "PROJECT_ROOT=%PROJECT_ROOT:"=%"

if not exist "%PROJECT_ROOT%" (
  echo ERROR: PROJECT_ROOT folder does not exist: %PROJECT_ROOT%
  exit /b 1
)

pushd "%PROJECT_ROOT%"

if not exist "server.js" (
  echo ERROR: server.js not found in %PROJECT_ROOT%.
  popd
  exit /b 1
)

set "PORT="
set "ENV_FILE=%PROJECT_ROOT%\.env"
if exist "%ENV_FILE%" (
  for /f "usebackq tokens=1* delims==" %%A in ("%ENV_FILE%") do (
    set "RAW_KEY=%%A"
    set "RAW_VAL=%%B"
    for /f "tokens=* delims= " %%K in ("!RAW_KEY!") do set "KEY=%%K"
    if /i "!KEY!"=="PORT" set "PORT=!RAW_VAL!"
  )
)

if not defined PORT set "PORT=3000"

start "Street Photo Tool Server" /B cmd /c "node server.js"

timeout /t 2 /nobreak >nul
start "Street Photo Tool" "http://localhost:%PORT%"

popd
exit /b 0

:load_paths
set "FILE=%~1"
for /f "usebackq tokens=1* delims==" %%A in ("%FILE%") do (
  set "RAW_KEY=%%A"
  set "RAW_VAL=%%B"
  for /f "tokens=* delims= " %%K in ("!RAW_KEY!") do set "KEY=%%K"
  if /i "!KEY:~0,3!"=="REM" (
    rem skip
  ) else if "!KEY:~0,1!"=="#" (
    rem skip
  ) else if "!KEY:~0,1!"==";" (
    rem skip
  ) else if "!KEY!"=="" (
    rem skip
  ) else (
    set "!KEY!=!RAW_VAL!"
  )
)
exit /b 0
