# Gera downloads/Instalar-Agendamento-Detran.exe (o que o site oferece em /baixar-app).
# Usa o csc.exe que vem no Windows (.NET Framework 4): não precisa instalar nada.
#   powershell -ExecutionPolicy Bypass -File ferramentas\agendamento-detran\instalador\build.ps1

$ErrorActionPreference = 'Stop'
$aqui = $PSScriptRoot
$ferramenta = Split-Path $aqui -Parent
$raiz = Split-Path (Split-Path $ferramenta -Parent) -Parent
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icone = Join-Path $aqui 'icone.ico'
$saida = Join-Path $raiz 'downloads\Instalar-Agendamento-Detran.exe'
$tmp = Join-Path $env:TEMP ('agendamento-build-' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $tmp 'app'

if (-not (Test-Path (Join-Path $ferramenta 'node_modules\playwright'))) {
  Push-Location $ferramenta; npm install --no-audit --no-fund; Pop-Location
}

# Ícone a partir da logo do site: ICO com as imagens em PNG (aceito desde o Vista).
if (-not (Test-Path $icone)) {
  Add-Type -AssemblyName System.Drawing
  $logo = [System.Drawing.Image]::FromFile((Join-Path $raiz 'logo-512.png'))
  $tamanhos = 16, 24, 32, 48, 64, 128, 256
  $pngs = foreach ($t in $tamanhos) {
    $bmp = New-Object System.Drawing.Bitmap $t, $t
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($logo, 0, 0, $t, $t); $g.Dispose()
    $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    , $ms.ToArray()
  }
  $logo.Dispose()
  $fs = [System.IO.File]::Create($icone); $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$tamanhos.Count)
  $offset = 6 + 16 * $tamanhos.Count
  for ($i = 0; $i -lt $tamanhos.Count; $i++) {
    $t = $tamanhos[$i]; $b = if ($t -ge 256) { 0 } else { $t }
    $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
  }
  foreach ($p in $pngs) { $w.Write($p) }
  $w.Close()
}

New-Item -ItemType Directory -Force $app | Out-Null
$refs = '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Management.dll', '/r:System.IO.Compression.dll'

& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/win32icon:$icone" @refs "/out:$app\AgendamentoDetran.exe" "$aqui\Lancador.cs" "$aqui\Comum.cs"
if ($LASTEXITCODE) { throw 'falhou ao compilar o lançador' }

# Só o que a ferramenta precisa. veiculos.json, registros/ e perfil-chrome/ têm
# dado de cliente; o .env do site fica de fora (as chaves são da MC).
foreach ($f in 'agendar.js', 'servidor.js', 'painel.html', 'package.json', 'package-lock.json', 'veiculos.exemplo.json', 'LEIA-ME.md') {
  Copy-Item (Join-Path $ferramenta $f) $app
}
Copy-Item (Join-Path $ferramenta 'node_modules') (Join-Path $app 'node_modules') -Recurse
Remove-Item (Join-Path $app 'node_modules\.bin') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item $icone $app

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $tmp 'app.zip'
[System.IO.Compression.ZipFile]::CreateFromDirectory($app, $zip, 'Optimal', $false)

New-Item -ItemType Directory -Force (Split-Path $saida) | Out-Null
& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/win32icon:$icone" @refs "/resource:$zip,app.zip" "/out:$saida" "$aqui\Instalador.cs" "$aqui\Comum.cs"
if ($LASTEXITCODE) { throw 'falhou ao compilar o instalador' }

Remove-Item $tmp -Recurse -Force
$mb = (Get-Item $saida).Length / 1MB
'{0} ({1:N2} MB)' -f $saida, $mb
# O site serve o arquivo pela function da Vercel, que corta resposta acima de 4,5 MB.
if ($mb -ge 4.4) { Write-Warning 'Acima de 4,4 MB: o download pelo site vai falhar (limite de 4,5 MB da Vercel).' }
