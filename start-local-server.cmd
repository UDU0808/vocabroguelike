@echo off
setlocal
cd /d "%~dp0"
echo.
echo Starting local web server from this folder...
echo Local page:       http://127.0.0.1:8030/
echo Asset check page: http://127.0.0.1:8030/check-assets.html
echo Tunnel target:    127.0.0.1:8030 or localhost:8030
echo.
where python >nul 2>nul
if %ERRORLEVEL%==0 (
    python -m http.server 8030 --bind 0.0.0.0
) else (
    py -3 -m http.server 8030 --bind 0.0.0.0
)
pause
