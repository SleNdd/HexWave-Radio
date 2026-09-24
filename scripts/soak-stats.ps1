param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][ValidateCount(1, 10)][string[]]$ContainerNames,
    [int]$Iterations = 1440,
    [int]$IntervalSeconds = 60
)

$ErrorActionPreference = 'Stop'
if ($Iterations -lt 1 -or $IntervalSeconds -lt 1) { throw 'Iterations and IntervalSeconds must be positive' }
for ($sample = 0; $sample -lt $Iterations; $sample++) {
    $sampleTime = [DateTimeOffset]::UtcNow.ToString('o')
    $rows = & docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' @ContainerNames
    if ($LASTEXITCODE -ne 0) { throw "docker stats failed with exit code $LASTEXITCODE" }
    if (@($rows).Count -ne $ContainerNames.Count) {
        throw "docker stats returned $(@($rows).Count) of $($ContainerNames.Count) requested containers"
    }
    foreach ($row in $rows) { Add-Content -LiteralPath $OutputPath -Value "$sampleTime,$row" }
    if ($sample + 1 -lt $Iterations) { Start-Sleep -Seconds $IntervalSeconds }
}
