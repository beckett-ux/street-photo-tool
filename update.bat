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

if not exist ".git" (
  echo ERROR: %PROJECT_ROOT% is not a git repository.
  popd
  exit /b 1
)

set "OLD_HEAD="
for /f "usebackq delims=" %%H in (`git rev-parse HEAD 2^>nul`) do set "OLD_HEAD=%%H"
if not defined OLD_HEAD (
  echo ERROR: Unable to read current git commit.
  popd
  exit /b 1
)

set "UPSTREAM="
for /f "usebackq delims=" %%U in (`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2^>nul`) do set "UPSTREAM=%%U"
if not defined UPSTREAM (
  echo ERROR: No upstream branch is configured for this repo.
  popd
  exit /b 1
)

set "BACKUP_PATH=%TEMP%\street-photo-tool-paths.txt.bak"
copy /y "paths.txt" "%BACKUP_PATH%" >nul

set "DELETED_LIST_FILE=%TEMP%\street-photo-tool-deleted.txt"
if exist "%DELETED_LIST_FILE%" del "%DELETED_LIST_FILE%"

git fetch --prune
if errorlevel 1 goto :pull_failed

for /f "usebackq delims=" %%F in (`git diff --name-only --diff-filter=D %OLD_HEAD%..%UPSTREAM%`) do (
  echo %%F>>"%DELETED_LIST_FILE%"
)

git pull --rebase --autostash
if errorlevel 1 goto :pull_failed

if exist "%BACKUP_PATH%" copy /y "%BACKUP_PATH%" "paths.txt" >nul

if exist "%DELETED_LIST_FILE%" (
  for /f "usebackq delims=" %%F in ("%DELETED_LIST_FILE%") do (
    if not exist "%%F" (
      git checkout %OLD_HEAD% -- "%%F" >nul 2>nul
      git reset -- "%%F" >nul 2>nul
    )
  )
)

popd

echo Update complete.
exit /b 0

:pull_failed
if exist "%BACKUP_PATH%" copy /y "%BACKUP_PATH%" "paths.txt" >nul
popd

echo Update failed.
exit /b 1

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
