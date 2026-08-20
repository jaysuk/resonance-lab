@echo off
setlocal

:: Path to a local checkout of the Vue 2.7 DuetWebControl 3.6 source tree.
:: (The 3.7+ build lives in build.bat and uses a different checkout entirely.)
set DWC36_DIR=c:\Users\live\Documents\Input Shaping\DuetWebControl-3.6-dev
set PLUGIN_ID=ResonanceLab
set STAGE_DIR=%TEMP%\resonance-lab-dwc36

:: %~dp0 has a trailing backslash - strip it for safe quoting
set PLUGIN_REPO=%~dp0
if "%PLUGIN_REPO:~-1%"=="\" set PLUGIN_REPO=%PLUGIN_REPO:~0,-1%

echo Cleaning stale build artifacts...
if exist "%DWC36_DIR%\dist\%PLUGIN_ID%-*.zip" del /q "%DWC36_DIR%\dist\%PLUGIN_ID%-*.zip"
:: build-plugin-pkg copies the plugin into the DWC source tree; a stale copy from an interrupted
:: run gets compiled again and reports errors against code that no longer exists.
if exist "%DWC36_DIR%\src\plugins\%PLUGIN_ID%" rmdir /s /q "%DWC36_DIR%\src\plugins\%PLUGIN_ID%"

:: DWC's builder always compiles <pluginDir>/src/index.ts and would choke on the Vue 3 sources, so
:: stage a tree holding only the shared core plus the 3.6 UI. See scripts/stage-dwc36.mjs.
echo Staging DWC 3.6 sources...
call node "%PLUGIN_REPO%\scripts\stage-dwc36.mjs" "%STAGE_DIR%"
if errorlevel 1 (
    echo Staging failed.
    exit /b 1
)

echo Building plugin against %DWC36_DIR% ...
cd /d "%DWC36_DIR%"
call npm run build-plugin-pkg -- "%STAGE_DIR%"
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

:: DWC 3.6's builder writes the ZIP into its own dist/; move it into the repo under a name that
:: distinguishes it from the 3.7 package (both carry the same plugin version).
for /f "delims=" %%f in ('dir /b /o-d "%DWC36_DIR%\dist\%PLUGIN_ID%-*.zip" 2^>nul') do (
    set ZIPNAME=%%f
    goto :found
)
echo No ZIP produced.
exit /b 1

:found
setlocal enabledelayedexpansion
set DEST=%PLUGIN_REPO%\!ZIPNAME:~0,-4!-dwc36.zip
if exist "!DEST!" del /q "!DEST!"
move /y "%DWC36_DIR%\dist\!ZIPNAME!" "!DEST!" >nul
rmdir /s /q "%DWC36_DIR%\src\plugins\%PLUGIN_ID%" 2>nul
echo Done: !DEST!
endlocal
