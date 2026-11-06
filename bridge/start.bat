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
del bridge-new.mjs start.new >nul 2>nul
curl.exe -fsSL --max-time 15 -o start.new "https://raw.githubusercontent.com/xsamikx-creator/Start3D/main/bridge/start.bat?t=%RANDOM%%RANDOM%" >nul 2>nul
if not exist start.new goto nostart
fc /b start.new start.bat >nul 2>nul
if not errorlevel 1 goto nostart
findstr /c:"Start3D" start.new >nul 2>nul
if errorlevel 1 goto nostart
echo Обновляю start.bat и перезапускаюсь...
copy /y start.new start.bat >nul & del start.new >nul 2>nul & start "" "%~f0" & exit
:nostart
del start.new >nul 2>nul
curl.exe -fsSL --max-time 15 -o bridge-new.mjs "https://raw.githubusercontent.com/xsamikx-creator/Start3D/main/bridge/bridge.mjs?t=%RANDOM%%RANDOM%" >nul 2>nul
if not exist bridge-new.mjs goto run
node --check bridge-new.mjs >nul 2>nul
if errorlevel 1 goto dropnew
fc /b bridge-new.mjs bridge.mjs >nul 2>nul
if errorlevel 1 (
  copy /y bridge-new.mjs bridge.mjs >nul
  echo Мост обновлён.
)
:dropnew
del bridge-new.mjs >nul 2>nul

:run
echo Запускаю мост...
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
