@echo off
chcp 65001 > nul
title Generador Automático de Carnets - Torneo San Antonio
cls
echo ========================================================
echo   GENERADOR AUTOMÁTICO DE PLANILLAS Y CARNETS
echo   Torneo San Antonio (Word y PDF)
echo ========================================================
echo.
echo [1/3] Leyendo fotos de la carpeta 'fotos_jugadores'...
echo [2/3] Creando documento Word (.docx) y convirtiendo a PDF (.pdf)...

node "%~dp0generador.js"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo   ¡LISTO! Los archivos se han generado con éxito.
    echo ========================================================
    echo.
    echo Abriendo la carpeta con los archivos...
    start "" "%~dp0salida"
    echo Abriendo el archivo PDF listo para imprimir...
    start "" "%~dp0salida\Carnets_Torneo.pdf"
) else (
    echo.
    echo [ERROR] Ocurrió un problema al generar los carnets.
    echo Revisa que las fotos tengan el formato: 'Equipo - Nombre.jpg'
    pause
)
