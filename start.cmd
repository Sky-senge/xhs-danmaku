@echo off
chcp 65001 >nul
title 小红书弹幕 · OBS 浏览器源
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没有找到 Node.js，请先安装：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 第一次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 启动中... 控制台会自动在浏览器里打开
echo 关闭这个窗口即停止服务。
echo.
node src/index.js %*

echo.
echo 服务已退出。
pause
