@echo off
setlocal enabledelayedexpansion

:: Path to a local checkout of the Vue 3 DuetWebControl (3.7+) source tree.
:: (The DWC 3.6 build lives in build36.bat and uses a different checkout entirely.)
set DWC_DIR=c:\Users\live\Documents\Github\DuetWebControl
set PLUGIN_ID=ResonanceLab

:: %~dp0 has a trailing backslash - strip it for safe quoting
set PLUGIN_REPO=%~dp0
if "%PLUGIN_REPO:~-1%"=="\" set PLUGIN_REPO=%PLUGIN_REPO:~0,-1%

echo Cleaning stale build artifacts...
if exist "%PLUGIN_REPO%\dist" rmdir /s /q "%PLUGIN_REPO%\dist"
if exist "%PLUGIN_REPO%\pkg" rmdir /s /q "%PLUGIN_REPO%\pkg"
:: Delete only THIS target's ZIPs. A bare %PLUGIN_ID%-*.zip also matches the -dwc36 package that
:: build36.bat produces (must survive), and a prerelease DWC checkout additionally emits a
:: <id>-<ver>-srcmap.zip alongside the real package (see the "Done" scan below for why). Substring
:: comparison, not findstr piped through a nested paren block - the latter is unreliable here
:: because cmd.exe pre-scans a whole for/do(...) body before executing it, and a `|` inside nested
:: `( )` groups within that body does not reliably bind to the command that produced it.
for %%z in ("%PLUGIN_REPO%\%PLUGIN_ID%-*.zip") do (
    set "ZIPNAME=%%~nz"
    if /i "!ZIPNAME:~-6!" NEQ "-dwc36" if /i "!ZIPNAME:~-7!" NEQ "-srcmap" del /q "%%~fz"
)

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

:: A prerelease DWC checkout (alpha/beta/rc) also emits <id>-<ver>-srcmap.zip alongside the real
:: package (see DWC's vite.config.mts / build-plugin-pkg.js) - exclude that too, or a build against
:: such a checkout reports the sourcemap archive as "Done" instead of the installable plugin.
for /f "delims=" %%f in ('dir /b /o-d "%PLUGIN_REPO%\%PLUGIN_ID%-*.zip" 2^>nul') do (
    set "ZIPNAME=%%~nf"
    if /i "!ZIPNAME:~-6!" NEQ "-dwc36" if /i "!ZIPNAME:~-7!" NEQ "-srcmap" (
        echo Done: %PLUGIN_REPO%\%%f
        goto :done
    )
)
echo No ZIP produced.
exit /b 1

:done
