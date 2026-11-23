@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.portable-env\node\node.exe" set "PATH=%~dp0.portable-env\node;%PATH%"
set "PATH=%~dp0resources\bin;%PATH%"
set "ELECTRON_CACHE=%~dp0.portable-env\electron-cache"
set "ELECTRON_BUILDER_CACHE=%~dp0.portable-env\electron-builder-cache"
set "NPM_CONFIG_CACHE=%~dp0.portable-env\npm-cache"
set "NODE_OPTIONS=--use-system-ca"
set "STREAMGRAB_PORTABLE_ROOT=%~dp0"

echo Starting StreamGrab Browser (Portable Dev Mode)...
call pnpm run dev
endlocal
