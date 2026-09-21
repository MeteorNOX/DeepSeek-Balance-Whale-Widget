@echo off
rem dsh-whale-widget 安装器（Windows 双击即用）
rem 参数会原样传给 installer\install.mjs，例如：install.cmd --no-voice
setlocal
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [x] 没有找到 Node.js。这个插件需要 Node 18 以上。
  echo     装法一：官网下载 https://nodejs.org  （推荐 LTS）
  echo     装法二：如果你已经装了 DSH desktop 版，它自带 Node，可改用：
  echo            "%%LOCALAPPDATA%%\Programs\dsh\resources\node\node.exe" installer\install.mjs
  echo.
  pause
  exit /b 1
)

node "%~dp0installer\install.mjs" %*
set RC=%ERRORLEVEL%
echo.
if %RC% neq 0 (
  echo [x] 安装没有成功完成（退出码 %RC%），把上面的输出发给分发者即可。
) else (
  echo [ok] 完成。记得重启 dsh web。
)
pause
exit /b %RC%
