@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node

node server.mjs --no-pairing
set "BILI_REMOTE_EXIT=%ERRORLEVEL%"
if "%BILI_REMOTE_EXIT%"=="0" goto finished

echo.
echo Bilibili Bed Remote failed to start.
echo Check whether local port 7331 is already in use.
goto hold_window

:no_node
set "BILI_REMOTE_EXIT=1"
echo Node.js was not found.
echo Install Node.js 18 or newer from https://nodejs.org/
goto hold_window

:finished
echo.
echo Bilibili Bed Remote has stopped.

:hold_window
echo.
pause
exit /b %BILI_REMOTE_EXIT%
