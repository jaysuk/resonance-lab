@echo off
setlocal

:: Path to a local checkout of the Vue 3 DuetWebControl (3.7+) source tree.
set DWC_DIR=c:\Users\live\Documents\Github\DuetWebControl
set PLUGIN_ID=ResonanceLab

:: %~dp0 has a trailing backslash - strip it for safe quoting
set PLUGIN_REPO=%~dp0
if "%PLUGIN_REPO:~-1%"=="\" set PLUGIN_REPO=%PLUGIN_REPO:~0,-1%

echo Cleaning stale build artifacts...
if exist "%PLUGIN_REPO%\dist" rmdir /s /q "%PLUGIN_REPO%\dist"
if exist "%PLUGIN_REPO%\pkg" rmdir /s /q "%PLUGIN_REPO%\pkg"
del /q "%PLUGIN_REPO%\%PLUGIN_ID%-*.zip" 2>nul

echo Building plugin against %DWC_DIR% ...
cd /d "%DWC_DIR%"
:: build-plugin-pkg packages a content-hashed, fully-installable ZIP (dwcFiles manifest populated).
call npm run build-plugin-pkg -- "%PLUGIN_REPO%"
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

:: build-plugin-pkg writes the ZIP into the plugin repo itself; tidy the intermediate dirs.
if exist "%PLUGIN_REPO%\dist" rmdir /s /q "%PLUGIN_REPO%\dist"
if exist "%PLUGIN_REPO%\pkg" rmdir /s /q "%PLUGIN_REPO%\pkg"

for /f "delims=" %%f in ('dir /b /o-d "%PLUGIN_REPO%\%PLUGIN_ID%-*.zip" 2^>nul') do (
    echo Done: %PLUGIN_REPO%\%%f
    goto :done
)
echo No ZIP produced.
exit /b 1

:done
