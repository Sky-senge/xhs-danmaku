@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

set "EXE="
for %%D in (C D E F G H) do (
  if exist "%%D:\Program Files\xhs-live-helper" (
    for /d %%V in ("%%D:\Program Files\xhs-live-helper\*") do (
      if exist "%%V\xhs-live-helper.exe" set "EXE=%%V\xhs-live-helper.exe"
    )
  )
)

if "%EXE%"=="" (
  echo.
  echo [x] xhs-live-helper not found.
  echo     Install it first, or put the full exe path into the plugin console field "helper path".
  echo.
  pause
  exit /b 1
)

echo Found: %EXE%
echo Launching with debug port %PORT% ...
powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath '%EXE%' -ArgumentList '--remote-debugging-port=%PORT%'"
if errorlevel 1 (
  echo.
  echo [x] Launch failed. Try: right click this file - Run as administrator.
  echo.
  pause
  exit /b 1
)

echo.
echo Done. Log in inside the helper window, then click [Start capture] in the plugin console.
echo.
timeout /t 4 >nul
