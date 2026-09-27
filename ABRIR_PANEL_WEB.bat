@echo off
chcp 65001 > nul
title Panel de Carnets - Torneo San Antonio
cls
echo ========================================================
echo   INICIANDO PANEL VISUAL DE CARNETS
echo   Torneo San Antonio
echo ========================================================
echo.
echo Iniciando servidor local en http://localhost:3000 ...
echo Abriendo en tu navegador...
echo.
echo Presiona Ctrl + C en esta ventana cuando quieras cerrar el programa.
echo.

start "" "http://localhost:3000"
node "%~dp0server.js"
pause
