@echo off
title Stop

echo Stopping...
taskkill /f /fi "WINDOWTITLE eq Flask*" >nul 2>nul
taskkill /f /fi "WINDOWTITLE eq Cloudflare*" >nul 2>nul
taskkill /f /im python.exe >nul 2>nul
ping 127.0.0.1 -n 3 >nul
echo Done.
timeout /t 3 >nul
