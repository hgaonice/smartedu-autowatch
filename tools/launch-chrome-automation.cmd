@echo off
REM ============================================================
REM  智慧教育平台 · 自动化专用 Chrome 启动器
REM
REM  为什么需要独立 profile：
REM    Chrome >= 136 起，使用默认 user-data-dir 时会直接忽略
REM    --remote-debugging-port（安全策略），因此无法对正在使用的
REM    日常 Chrome 开 CDP。必须用独立 user-data-dir。
REM
REM  ⚠ 首次使用需要在这个新 profile 里手动登录一次智慧教育平台，
REM    之后登录态会长期保留（profile 目录不会被自动清理）。
REM
REM  本机 Chrome 版本：153.0.8010.53
REM ============================================================

setlocal
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set PROFILE=%LOCALAPPDATA%\smartedu-auto-profile
set PORT=9222
set TARGET=https://basic.smartedu.cn/

if not exist %CHROME% (
  echo [错误] 未找到 Chrome：%CHROME%
  echo         请修改本文件里的 CHROME 变量。
  pause
  exit /b 1
)

echo [信息] 独立 profile：%PROFILE%
echo [信息] CDP 端口：%PORT%
echo [信息] 目标页面：%TARGET%
echo.

start "" %CHROME% ^
  --remote-debugging-port=%PORT% ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=Translate,OptimizationHints ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-background-media-suspend ^
  --autoplay-policy=no-user-gesture-required ^
  --window-size=1100,820 ^
  "%TARGET%"

echo [完成] Chrome 已启动。
echo.
echo   验证 CDP 是否就绪：
echo     curl -s http://127.0.0.1:%PORT%/json/version
echo.
echo   注意：日常用的 Chrome 请先完全退出，否则新实例可能
echo         被合并进已有进程，调试端口不会打开。
echo.
pause
