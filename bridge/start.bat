@echo off
chcp 65001 >nul
title Start3D мост
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Устанавливаю Node.js LTS с официального источника...
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo Готово. Закройте это окно и снова запустите start.bat
  pause
  exit /b
)

if not exist node_modules (
  echo Устанавливаю зависимости...
  call npm install --no-audit --no-fund
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo.
  echo Откроется config.json. Впишите bridgeKey, serial и accessCode, сохраните и закройте Блокнот.
  notepad config.json
)

:loop
rem Self-update: fetch the latest bridge.mjs from GitHub; keep the current one if the download fails or the file is broken.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri 'https://raw.githubusercontent.com/xsamikx-creator/Start3D/main/bridge/bridge.mjs' -OutFile 'bridge.new' } catch { }" >nul 2>nul
if exist bridge.new (
  node --check bridge.new >nul 2>nul && (fc /b bridge.new bridge.mjs >nul 2>nul || (copy /y bridge.new bridge.mjs >nul & echo Мост обновлён до последней версии.))
  del bridge.new >nul 2>nul
)
node bridge.mjs
echo.
echo Мост остановился. Перезапуск через 10 секунд... (закройте окно, чтобы остановить)
timeout /t 10 /nobreak >nul
goto loop
