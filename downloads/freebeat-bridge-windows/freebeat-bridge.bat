@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo          Freebeat Bridge Windows
echo ============================================
echo.
echo Bridge ini membuka Freebeat di browser biasa.
echo Login sendiri di jendela browser yang muncul.
echo.

if exist node_modules goto START_BRIDGE

echo [1/2] Menginstall browser dependency (sekali saja)...
call npm install
if errorlevel 1 goto NPM_FAILED

call npx playwright install chromium
if errorlevel 1 goto BROWSER_FAILED

:START_BRIDGE
echo [2/2] Menjalankan Bridge...
call node freebeat-bridge.js
pause
exit /b

:NPM_FAILED
echo [ERROR] npm install gagal. Pastikan Node.js sudah terpasang.
pause
exit /b 1

:BROWSER_FAILED
echo [ERROR] Browser Playwright gagal terpasang.
pause
exit /b 1