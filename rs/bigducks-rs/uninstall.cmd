@echo off
setlocal
cd /d "%~dp0"

echo.
echo  FECHE O DISCORD E O CANARY ANTES DE CONTINUAR.
echo.
pause

echo Removendo a injecao do Desjanjador...
target\release\Desjanjador.exe --console --uninstall

echo.
echo  Pronto. O app.asar original foi restaurado.
echo  Abra o Discord normalmente.
echo.
pause
