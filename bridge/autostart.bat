@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Start3D мост.lnk'); $s.TargetPath='%~dp0start.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
echo Готово: мост будет запускаться сам при входе в Windows.
pause
