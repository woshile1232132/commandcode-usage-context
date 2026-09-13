@echo off
set "DEST=%USERPROFILE%\.commandcode\mods\usage-context"
if exist "%DEST%" rmdir /s /q "%DEST%"
echo [OK] uninstalled. Restart your commandcode session.
pause
