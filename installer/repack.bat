@echo off
rem ZS Live one-click repack. Optional args: version (e.g. 1.1.0), /skipue
rem Examples:
rem   repack.bat                 - rebuild with current version
rem   repack.bat 1.1.0           - rebuild and bump version
rem   repack.bat 1.1.0 /skipue   - rebuild without refreshing UE packages
set ARGS=%*
if "%ARGS%"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0repack.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0repack.ps1" %ARGS%
)
pause
