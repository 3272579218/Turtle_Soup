@echo off
title Server

echo ========================================
echo   Turtle Soup Server
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] Cleaning...
taskkill /f /fi "WINDOWTITLE eq Flask*" >nul 2>nul
taskkill /f /im python.exe >nul 2>nul
ping 127.0.0.1 -n 3 >nul

echo [2/3] Starting...
start "Flask Server" "f:/anaconda/python.exe" app.py
ping 127.0.0.1 -n 4 >nul

echo [3/3] Opening browser...
start http://127.0.0.1:5000

echo.
echo ========================================
echo   Started!
echo   http://127.0.0.1:5000
echo ========================================
echo.
timeout /t 5 >nul
