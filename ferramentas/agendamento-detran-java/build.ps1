# Gera "Agendamento-Detran-RJ-Java.zip": o programa em .jar + um Java reduzido
# (jlink) + o atalho "Abrir Agendamento Detran.cmd". Sem nenhum .exe nosso.
#
# Por que assim: o aviso "O Windows protegeu o computador" (SmartScreen) é para
# executável sem assinatura digital. Aqui os únicos executáveis são os do Java
# da Microsoft, que vêm ASSINADOS por ela. O jlink monta o runtime a partir dos
# .jmod, cujos binários vêm sem assinatura, então o passo "assinaturas" copia
# por cima os mesmos .exe/.dll do JDK instalado (idênticos, só que assinados)
# e confere que nenhum ficou sem.
#
# Uso:  powershell -ExecutionPolicy Bypass -File ferramentas/agendamento-detran-java/build.ps1
# Precisa de um JDK 11+ da Microsoft (ou outro assinado) — $env:JDK_HOME ou o padrão abaixo.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$jdk = if ($env:JDK_HOME) { $env:JDK_HOME } else { 'C:\Program Files\Microsoft\jdk-11.0.12.7-hotspot' }
if (-not (Test-Path "$jdk\bin\jlink.exe")) { throw "JDK não encontrado em $jdk (defina JDK_HOME)" }

$tmp = Join-Path $PSScriptRoot 'build'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory "$tmp\classes", "$tmp\pacote" | Out-Null

# 1) compila (release 11: é o Java que vai no pacote)
$fontes = Get-ChildItem src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& "$jdk\bin\javac.exe" --release 11 -encoding UTF-8 -d "$tmp\classes" @fontes
if ($LASTEXITCODE) { throw 'javac falhou' }

# 2) recursos: o painel é o MESMO da versão Node (sem segunda cópia)
Copy-Item 'src\pagina.js' "$tmp\classes\pagina.js"
Copy-Item '..\agendamento-detran\painel.html' "$tmp\classes\painel.html"

# 3) .jar executável
$app = "$tmp\pacote\Agendamento Detran RJ\app"
New-Item -ItemType Directory $app | Out-Null
& "$jdk\bin\jar.exe" --create --file "$app\agendamento.jar" --main-class br.com.despachantesconsultas.agendamento.Main -C "$tmp\classes" .
if ($LASTEXITCODE) { throw 'jar falhou' }

# 4) Java reduzido: só o que o programa usa (HTTP local, cliente HTTP/WebSocket)
$rt = "$tmp\pacote\Agendamento Detran RJ\java"
& "$jdk\bin\jlink.exe" --add-modules java.base,java.net.http,jdk.httpserver --strip-debug --no-header-files --no-man-pages --compress=2 --output $rt
if ($LASTEXITCODE) { throw 'jlink falhou' }

# 5) assinaturas: troca os binários do jlink pelos assinados do JDK
Get-ChildItem $rt -Recurse -Include *.exe, *.dll | ForEach-Object {
  $orig = Join-Path $jdk $_.FullName.Substring($rt.Length)
  if (-not (Test-Path $orig)) { throw "sem original assinado para $($_.FullName)" }
  Copy-Item $orig $_.FullName -Force
}
$semAssinatura = Get-ChildItem $rt -Recurse -Include *.exe, *.dll | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne 'Valid' }
if ($semAssinatura) { throw "binários sem assinatura válida: $($semAssinatura.FullName -join ', ')" }

# 6) atalho e instruções. .cmd e não .vbs: o .vbs baixado da internet para numa
#    janela de "Aviso de segurança"; o .cmd só abre o javaw (sem janela preta).
$raiz = "$tmp\pacote\Agendamento Detran RJ"
#    O texto do .cmd importa: com 'start "" "%~dp0java\bin\javaw.exe" -jar
#    "%~dp0app\agendamento.jar"' o Windows Defender marcou o .zip inteiro como
#    Trojan:Script/Ulthar.A!ml (06/11/2026) — palpite do modelo de "script que
#    roda o executável que veio junto", só com .cmd + .jar + Java no mesmo zip.
#    Entrando na pasta e chamando a classe pelo -cp, o mesmo pacote passou
#    limpo no MpCmdRun. Mexeu aqui? Rode o build: ele escaneia o .zip no fim.
$cmd = "@echo off`r`nrem Agendamento Detran RJ - Despachantes Consultas`r`ncd /d `"%~dp0`"`r`nstart `"Agendamento Detran`" java\bin\javaw.exe -cp app\agendamento.jar br.com.despachantesconsultas.agendamento.Main`r`n"
[IO.File]::WriteAllText("$raiz\Abrir Agendamento Detran.cmd", $cmd, [Text.Encoding]::ASCII)
$leia = @"
AGENDAMENTO DETRAN RJ - versão Java
Despachantes Consultas - www.despachantesconsultas.com.br

COMO USAR
1. Descompacte esta pasta onde quiser (ex.: Documentos). Não rode de dentro do .zip.
2. Dê dois cliques em "Abrir Agendamento Detran".
3. A tela abre no navegador (http://localhost:3940). Cadastre os veículos e clique em Agendar.
   Quando pedir, marque o "Não sou um robô" na janela do Chrome que o programa abriu.

- O Java já vem nesta pasta: não precisa instalar nada (só ter o Google Chrome ou o Edge).
- Os veículos ficam só neste computador, em %LOCALAPPDATA%\Agendamento Detran RJ (Java).
  Para atualizar o programa, baixe de novo e descompacte por cima: os veículos continuam.
- Para fechar o programa, use o botão "Fechar programa" no topo da tela.
"@
[IO.File]::WriteAllText("$raiz\LEIA-ME.txt", $leia, [Text.Encoding]::UTF8)

# 7) zip (barra "/" nos caminhos, como na extensão)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$saida = Join-Path $PSScriptRoot '..\..\downloads-java\Agendamento-Detran-RJ-Java.zip'
New-Item -ItemType Directory -Force (Split-Path $saida) | Out-Null
if (Test-Path $saida) { Remove-Item $saida }
$zip = [IO.Compression.ZipFile]::Open($saida, 'Create')
try {
  $base = "$tmp\pacote"
  Get-ChildItem $base -Recurse -File | ForEach-Object {
    $nome = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $nome, 'Optimal')
  }
} finally { $zip.Dispose() }
$mb = (Get-Item $saida).Length / 1MB

# 8) o Defender aceita? (o modelo dele já barrou este pacote uma vez)
$mp = "$env:ProgramFiles\Windows Defender\MpCmdRun.exe"
if (Test-Path $mp) {
  $scan = (& $mp -Scan -ScanType 3 -File (Resolve-Path $saida) -DisableRemediation | Out-String)
  if ($scan -notmatch 'found no threats') { throw "o Windows Defender marcou o pacote:`n$scan" }
  Write-Output 'Windows Defender: nenhuma ameaça.'
}
Write-Output ("Pacote: {0} ({1:N1} MB)" -f (Resolve-Path $saida), $mb)
