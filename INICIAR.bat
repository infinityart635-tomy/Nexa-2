@echo off
setlocal
cd /d "%~dp0"

set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encontro Node.js.
  echo Instala Node.js LTS desde https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo ==============================
echo   INICIANDO SERVIDOR
echo ==============================
echo.

set "PORT=%PORT%"
start "" /b node server.js

echo Abriendo navegador...
timeout /t 2 >nul
start "" "http://localhost:%PORT%/"

echo.
echo Servidor en ejecucion.
echo Para detener: cierra esta ventana.
echo.
pause >nul
