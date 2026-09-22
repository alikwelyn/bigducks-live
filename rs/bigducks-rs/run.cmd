@echo off
setlocal
cd /d "%~dp0"
set PATH=%USERPROFILE%\.cargo\bin;%PATH%

if not exist target\release\bigducks-rs.exe (
  echo Compilando - primeira vez, ~1 minuto...
  cargo build --release
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao compilar.
    pause
    exit /b 1
  )
)

echo.
echo  BIG DUCKS RS
echo   - instala o bridge no Discord (automatico, sem colar nada)
echo   - captura a tela e transmite para os Discords abertos
echo.
echo  Painel no navegador: http://127.0.0.1:8791/
echo  Deixe esta janela aberta. Ctrl+C para parar.
echo.

target\release\bigducks-rs.exe --width 1280 --height 720 --fps 20 --port 8791 --nitro %*
echo.
pause
