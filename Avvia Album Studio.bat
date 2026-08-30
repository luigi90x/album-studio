@echo off
rem Doppio clic su questo file: avvia l'app in locale e apre il browser.
rem Serve Node.js installato. La finestra resta aperta mentre lavori.
cd /d "%~dp0"
node avvia-locale.js
if errorlevel 1 (
  echo.
  echo Qualcosa non ha funzionato. Se manca Node.js, scaricalo da https://nodejs.org
  pause
)
