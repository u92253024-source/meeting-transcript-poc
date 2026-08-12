@echo off
setlocal
title Meeting Transcript

pushd "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node.js before starting the app.
  goto :failed
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js before starting the app.
  goto :failed
)

if /I "%~1"=="--check" (
  if not exist "node_modules\" (
    echo [NOT READY] Project dependencies are not installed.
    popd
    exit /b 2
  )
  echo [READY] Node.js, npm, and project dependencies are available.
  popd
  exit /b 0
)

if not exist "node_modules\" (
  echo First launch: installing project dependencies...
  call npm.cmd ci --cache ".npm-cache"
  if errorlevel 1 goto :failed
)

echo Starting Meeting Transcript...
call npm.cmd run desktop
if errorlevel 1 goto :failed

popd
exit /b 0

:failed
echo.
echo Startup failed. Keep this window open and review the error above.
popd
pause
exit /b 1
