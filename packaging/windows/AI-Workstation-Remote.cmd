@echo off
setlocal
cd /d "%~dp0"
set "CLOUDFLARED_BIN=%~dp0helpers\cloudflared.exe"
set "CURSOR_INPUT_HELPER=%~dp0helpers\cursor-input-helper.ps1"
"%~dp0runtime\bin\node.exe" "%~dp0app\start-packaged.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
