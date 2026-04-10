@echo off
setlocal
cd /d "%~dp0"

echo.
echo ==============================
echo   INSTALAR DEPENDENCIAS
echo ==============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encontro Node.js en el PATH.
  echo Descarga e instala Node.js LTS desde:
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encontro npm.
  echo Reinstala Node.js LTS desde https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo Ejecutando: npm install
echo.

npm install
if errorlevel 1 (
  echo.
  echo ERROR: Fallo "npm install".
  echo Copia el error y pasamelo.
  echo.
  pause
  exit /b 1
)

echo.
echo LISTO. Ahora ejecuta INICIAR.bat
echo.
pause
