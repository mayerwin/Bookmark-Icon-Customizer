@echo off
REM Package the extension for Chrome Web Store upload.
REM Calls package.ps1, which reads the version from manifest.json and
REM writes dist\bookmark-icon-customizer-v<version>.zip (overwriting any
REM previous build of the same version). Only runtime files are included.

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package.ps1"
set RC=%ERRORLEVEL%

if %RC% neq 0 (
  echo.
  echo Packaging failed.
)

echo.
pause
exit /b %RC%
