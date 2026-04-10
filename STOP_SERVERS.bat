@echo off
setlocal

echo [1/2] Cerrando procesos en el puerto 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr LISTENING') do (
  echo - PID %%a
  taskkill /PID %%a /F >nul 2>&1
)

echo [2/2] Cerrando node.exe relacionados con server.js...
for /f "tokens=2 delims=," %%a in ('wmic process where "name='node.exe' and commandline like '%%server.js%%'" get ProcessId /format:csv') do (
  if not "%%a"=="" (
    echo - PID %%a
    taskkill /PID %%a /F >nul 2>&1
  )
)

echo Listo.
endlocal
