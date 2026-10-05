param(
  [int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction Stop
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 26) { throw "SHAO exige Node 26+ (node:sqlite); encontrado $(& $node.Source --version)." }
$env:SHAO_PORT = "$Port"
Push-Location $PSScriptRoot
try { & npm.cmd --prefix backend run start } finally { Pop-Location }
