@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 教师研修 · 自动挂课

echo.
echo   教师研修 · 自动挂课
echo   ────────────────────────────────────
echo.

rem ── 检查 Node.js ──
where node >nul 2>nul
if errorlevel 1 (
  echo   [缺少 Node.js] 需要先安装才能运行。
  echo.
  echo   1. 打开 https://nodejs.org/zh-cn/download
  echo   2. 下载 LTS 版本，一路「下一步」装完
  echo   3. 关掉这个窗口，重新双击 start.bat
  echo.
  start "" https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)

rem ── 检查依赖（首次运行需要）──
if not exist "node_modules\playwright-core" (
  echo   首次运行，正在准备依赖（只做一次，约十几秒）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [依赖安装失败] 请检查网络后重试。
    pause
    exit /b 1
  )
  echo   准备完成。
  echo.
)

rem ── 启动界面 ──
node src\web\launch.mjs

if errorlevel 1 (
  echo.
  echo   启动失败，请把上面的提示截图发给提供本工具的人。
  pause
)
