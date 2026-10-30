param(
    [switch]$Web,
    [string]$HostName = "0.0.0.0",
    [int]$Port = 8088,
    [string]$Token = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$exe = Join-Path $PSScriptRoot "fluidcan-studio.exe"
if (-not (Test-Path $exe)) {
    $exe = Join-Path $PSScriptRoot "target\release\fluidcan-studio.exe"
}
if (-not (Test-Path $exe)) {
    throw "fluidcan-studio.exe 不存在，请先 cargo build --release"
}

if ($Web) {
    $env:FLUIDCAN_MODE = "web"
    $env:FLUIDCAN_WEB_HOST = $HostName
    $env:FLUIDCAN_WEB_PORT = "$Port"
    if ($Token -ne "") { $env:FLUIDCAN_WEB_TOKEN = $Token }
    Write-Host "启动 Web 模式：http://${HostName}:${Port}/"
    & $exe --web
} else {
    & $exe
}
