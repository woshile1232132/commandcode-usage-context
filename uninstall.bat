@echo off
set "DEST=%USERPROFILE%\.commandcode\mods\commandcode-usage"
if exist "%DEST%" rmdir /s /q "%DEST%"
echo [OK] uninstalled. Restart your commandcode session.
pause
