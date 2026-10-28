@echo off
chcp 65001 >nul
title Start3D мост
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
if not exist node_modules call npm install --no-audit --no-fund
if not exist config.json goto noconfig

:loop
echo Проверяю обновление моста...
del bridge.new >nul 2>nul
curl.exe -fsSL --max-time 15 -o bridge.new "https://raw.githubusercontent.com/xsamikx-creator/Start3D/main/bridge/bridge.mjs?t=%RANDOM%%RANDOM%" >nul 2>nul
if not exist bridge.new goto run
node --check bridge.new >nul 2>nul
if errorlevel 1 goto dropnew
fc /b bridge.new bridge.mjs >nul 2>nul
if errorlevel 1 (
  copy /y bridge.new bridge.mjs >nul
  echo Мост обновлён.
)
:dropnew
del bridge.new >nul 2>nul

:run
node bridge.mjs
echo.
echo Мост остановился. Перезапуск через 10 секунд... (закройте окно, чтобы остановить)
timeout /t 10 /nobreak >nul
goto loop

:nonode
echo Node.js не найден. Устанавливаю Node.js LTS с официального источника...
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo.
echo Готово. Закройте это окно и снова запустите start.bat
pause
exit /b

:noconfig
copy config.example.json config.json >nul
echo.
echo Откроется config.json. Впишите bridgeKey, serial и accessCode, сохраните и закройте Блокнот.
notepad config.json
goto loop
