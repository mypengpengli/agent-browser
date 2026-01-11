@echo off
:: Cross-platform launcher for agent-browser (Windows)
:: Detects architecture and runs the appropriate native binary

setlocal

set "SCRIPT_DIR=%~dp0"

:: Detect architecture
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
    set "ARCH=x64"
) else if "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
    set "ARCH=arm64"
) else (
    set "ARCH=x64"
)

set "BINARY=%SCRIPT_DIR%agent-browser-win32-%ARCH%.exe"

:: Try native binary first
if exist "%BINARY%" (
    "%BINARY%" %*
    exit /b %errorlevel%
)

:: Fallback to Node.js implementation
set "NODE_CLI=%SCRIPT_DIR%..\dist\cli-light.js"
if exist "%NODE_CLI%" (
    node "%NODE_CLI%" %*
    exit /b %errorlevel%
)

echo Error: No binary found for win32-%ARCH% >&2
echo Run 'npm run build:native' or 'npm run build:all-platforms' to build >&2
exit /b 1
