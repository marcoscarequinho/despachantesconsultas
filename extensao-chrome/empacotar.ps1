# Gera o .zip para enviar à Chrome Web Store, só com o que o Chrome precisa.
# Uso (na pasta extensao-chrome):  powershell -ExecutionPolicy Bypass -File .\empacotar.ps1
# O zip sai em extensao-chrome\dist\ (fora do git).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$versao = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$saida = Join-Path $PSScriptRoot "dist\despachantes-consultas-v$versao.zip"
New-Item -ItemType Directory -Force (Split-Path $saida) | Out-Null
if (Test-Path $saida) { Remove-Item $saida }

# Lista explícita em vez de "tudo menos": arquivo novo na pasta não entra no
# pacote por acidente (README, CHROMEWEBSTORE.md e este script ficam fora).
$arquivos = @('manifest.json', 'popup.html', 'popup.css', 'popup.js') +
  (Get-ChildItem icons -File | ForEach-Object { "icons/$($_.Name)" })

# Não usa Compress-Archive: no PowerShell 5.1 ele grava "icons\icon-16.png"
# com barra invertida, e o Chrome não acha os ícones referenciados no manifest.
$zip = [System.IO.Compression.ZipFile]::Open($saida, 'Create')
try {
  foreach ($a in $arquivos) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PSScriptRoot $a), $a)
  }
} finally { $zip.Dispose() }
Write-Output "Pacote: $saida"
