@echo off
cd /d "%~dp0"
rem 指向本地 electron.exe 运行时：设置环境变量 ATK_ELECTRON_EXE 即可
set "ELECTRON_EXE=%ATK_ELECTRON_EXE%"
set "ELECTRON_RUN_AS_NODE="
if not exist "%ELECTRON_EXE%" goto missing
start "" "%ELECTRON_EXE%" .
exit /b 0
:missing
echo.
echo   Electron runtime not found:
echo     %ELECTRON_EXE%
echo.
echo   Run npm install in that project once, or set ATK_ELECTRON_EXE.
echo.
pause
exit /b 1
