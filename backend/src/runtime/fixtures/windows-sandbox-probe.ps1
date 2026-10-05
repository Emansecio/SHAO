param([Parameter(Mandatory=$true)][string]$CaseRoot, [Parameter(Mandatory=$true)][string]$OutsideSentinel)
$ErrorActionPreference = 'Stop'
$caseMarker = Join-Path $CaseRoot 'read-marker.txt'
$writeTarget = Join-Path $CaseRoot 'write-probe.txt'
$caseRead = $false
$caseWrite = 'denied'
$outsideRead = $false
try { $caseRead = [IO.File]::ReadAllText($caseMarker) -eq 'SHAO_LOCAL_CASE_SENTINEL' } catch {}
try {
  [IO.File]::WriteAllText($writeTarget, 'SHAO_LOCAL_WRITE_PROBE')
  $caseWrite = 'allowed'
  Remove-Item -LiteralPath $writeTarget -Force -ErrorAction SilentlyContinue
} catch {}
try { $outsideRead = [IO.File]::ReadAllText($OutsideSentinel) -eq 'SHAO_LOCAL_OUTSIDE_SENTINEL' } catch {}
[ordered]@{ caseRead=$caseRead; caseWrite=$caseWrite; outsideSentinelRead=$outsideRead } | ConvertTo-Json -Compress
