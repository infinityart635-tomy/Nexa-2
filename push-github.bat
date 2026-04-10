@echo off
setlocal

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-github.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
  echo El script termino bien.
) else (
  echo El script termino con errores.
)
echo La ventana queda abierta para que puedas leer el resultado.
pause
endlocal & exit /b %EXITCODE%
