@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "URL=https://2582ab98-7591-47d0-9afb-78f266758bf4-00-24gl24vxcm7oq.sisko.replit.dev/api/download/proof-login.js"

echo ============================================
echo   Picsart Local Runner (AUTO-UPDATE)
echo ============================================
echo.
echo  PENTING: pastikan SURFSHARK sudah NYALA,
echo  Google Chrome terpasang, dan config.json
echo  sudah dibuat (copy dari config.example.json)
echo  lalu diisi email + password.
echo.
pause

echo.
echo [1/3] Mengunduh script TERBARU dari server...
curl -fsSL -o proof-login.js.new "%URL%"
if exist proof-login.js.new (
  move /y proof-login.js.new proof-login.js >nul
  echo    OK - script terbaru terpasang.
) else (
  echo    Gagal unduh ^(server mungkin mati / internet^). Pakai script yang ada.
)

if not exist node_modules (
  echo.
  echo [2/3] Menginstall dependencies ^(sekali aja, agak lama^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install gagal. Pastikan Node.js sudah terpasang.
    pause
    exit /b 1
  )
) else (
  echo [2/3] Dependencies sudah ada, lanjut.
)

echo.
echo [3/3] Menjalankan...
echo.
call node proof-login.js

echo.
echo ============================================
echo  Selesai. Cek folder "screenshots" untuk
echo  hasil tiap langkah, dan token-found.txt.
echo ============================================
pause
