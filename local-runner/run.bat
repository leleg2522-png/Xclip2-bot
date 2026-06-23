@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   Picsart Local Runner - Proof Login
echo ============================================
echo.
echo  PENTING: Pastikan SURFSHARK sudah NYALA
echo  dan Google Chrome sudah terpasang.
echo.
echo  Pastikan juga file config.json sudah dibuat
echo  (copy dari config.example.json) dan diisi.
echo.
pause

if not exist node_modules (
  echo.
  echo Menginstall dependencies... ^(sekali aja, agak lama^)
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install gagal. Pastikan Node.js sudah terpasang.
    pause
    exit /b 1
  )
)

echo.
echo Menjalankan proof login...
echo.
call node proof-login.js

echo.
echo ============================================
echo  Selesai. Buka folder "screenshots" untuk
echo  melihat hasil tiap langkah.
echo ============================================
pause
