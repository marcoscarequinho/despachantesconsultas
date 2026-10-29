@echo off
rem Abre a tela do agendamento assistido do Detran RJ (dois cliques).
chcp 65001 >nul
title Agendamento Detran RJ
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado. Baixe em https://nodejs.org e clique de novo.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Primeira vez: instalando o que o agendamento precisa...
  call npm install --no-audit --no-fund
)

node servidor.js
if errorlevel 1 pause
