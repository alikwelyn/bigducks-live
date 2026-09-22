@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  BIG DUCKS - Go Live sender (teste)
echo ============================================
echo.

if not exist config.json (
  copy config.example.json config.json >nul
  echo  config.json criado a partir do exemplo.
)

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERRO] Node.js nao encontrado no PATH.
  goto :fim
)

echo  Node: & node -v
echo.

if not exist node_modules (
  echo  Instalando dependencias ^(npm install^)... isso demora alguns minutos.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [ERRO] npm install falhou. Veja o erro acima.
    goto :fim
  )
)

echo.
echo  Iniciando Go Live de teste. Ctrl+C para parar.
echo.
node sender.mjs
echo.
echo  [sender terminou com codigo %errorlevel%]

:fim
echo.
pause
