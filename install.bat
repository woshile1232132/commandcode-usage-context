@echo off



chcp 65001 >nul



setlocal



set "DEST=%USERPROFILE%\.commandcode\mods\commandcode-usage-context"







rem 1) 检测 CommandCode CLI 数据目录



if not exist "%USERPROFILE%\.commandcode" (



  echo [ERROR] 未检测到 Command Code CLI（缺少 %USERPROFILE%\.commandcode 目录）



  echo         请先安装: npm i -g command-code



  pause



  exit /b 1



)



echo [OK] 检测到 Command Code CLI







rem 2) 探测 cmdc 命令并显示版本（可选，失败不影响安装）



where cmdc >nul 2>&1



if errorlevel 1 (



  echo [提示] PATH 中未找到 cmdc，请自行确认 CLI 可用



) else (



  for /f "delims=" %%v in ('cmdc --version 2^>nul') do echo [OK] CLI 版本 %%v



)







rem 3) 检测 atime（子过程，见文件末尾）



call :atimecheck







rem 4) 安装 mod



if not exist "%USERPROFILE%\.commandcode\mods" mkdir "%USERPROFILE%\.commandcode\mods"



if not exist "%DEST%" mkdir "%DEST%"



copy /y "%~dp0commandcode-usage-context\index.mjs" "%DEST%\index.mjs" >nul



if errorlevel 1 (



  echo [ERROR] 复制失败，请手动将 commandcode-usage-context 文件夹复制到 %DEST%



  pause



  exit /b 1



)



echo [OK] mod 已安装到 %DEST%



echo 重开 commandcode 会话即可生效。



pause



exit /b 0







:atimecheck

set "ATIME_EFF="

for /f "tokens=3" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v NtfsDisableLastAccessUpdate 2^>nul') do set /a "ATIME_EFF = %%a & 3" >nul

if not defined ATIME_EFF ( echo [提示] 无法读取 atime 设置（需管理员），不影响安装 & goto :eof )

if "%ATIME_EFF%"=="0" echo [OK] atime 已启用

if "%ATIME_EFF%"=="2" echo [OK] atime 已启用（系统托管）

if "%ATIME_EFF%"=="1" echo [WARN] atime 已禁用，/sessions 恢复识别会退化

if "%ATIME_EFF%"=="3" echo [WARN] atime 已禁用，/sessions 恢复识别会退化

goto :eof