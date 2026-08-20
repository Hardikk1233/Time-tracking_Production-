@echo off
REM Launcher for setup-entra.ps1.
REM
REM Windows blocks .ps1 files by default (execution policy "Restricted"), which
REM stops the script running even though it sits in your own repository. This
REM bypasses that for THIS process only - no machine-wide setting is changed
REM and nothing is left altered afterwards.
REM
REM Usage - the arguments are passed straight through:
REM
REM   scripts\setup-entra.cmd -RedirectUri "https://timetrack.example.com" -WhatIf
REM   scripts\setup-entra.cmd -RedirectUri "https://timetrack.example.com"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-entra.ps1" %*
exit /b %ERRORLEVEL%
