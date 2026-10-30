param(
    [string]$WorkDir = "",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$source = Split-Path $PSScriptRoot -Parent
if ($WorkDir -eq "") { $WorkDir = Join-Path $env:LOCALAPPDATA "FluidCAN-Studio\android-build" }

# The Android NDK linker cannot handle non-ASCII project paths on Windows.
# Copy to an ASCII work directory when necessary.
if ($source -notmatch '^[A-Za-z]:\\[^\u4e00-\u9fff]*$') {
    New-Item -ItemType Directory $WorkDir -Force | Out-Null
    robocopy $source $WorkDir /E /XD target node_modules gen\android\.gradle gen\android\build gen\android\app\build /NFL /NDL /NJH /NJS | Out-Null
} else {
    $WorkDir = $source
}

if (-not $env:JAVA_HOME) {
    $candidate = "C:\Program Files\Android\Android Studio\jbr"
    if (Test-Path $candidate) { $env:JAVA_HOME = $candidate }
}
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME "ndk") -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($ndk) { $env:NDK_HOME = $ndk.FullName }

Set-Location $WorkDir
if (-not (Test-Path "node_modules\.bin\tauri.cmd")) {
    npm install --ignore-scripts
}

npx tauri android build --apk --target aarch64 --split-per-abi

$unsigned = Get-ChildItem "gen\android\app\build\outputs\apk" -Recurse -Filter "*-release-unsigned.apk" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $unsigned) { throw "release APK not found" }

$out = if ($OutDir -ne "") { $OutDir } else { Join-Path $source "dist" }
New-Item -ItemType Directory $out -Force | Out-Null
$apk = Join-Path $out "FluidCAN-Studio-android-arm64.apk"

$keyStore = Join-Path $env:USERPROFILE ".android\debug.keystore"
if (-not (Test-Path $keyStore)) {
    keytool -genkeypair -keystore $keyStore -storepass android -keypass android `
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=Android Debug,O=Android,C=US"
}

$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME "build-tools") -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
$apksigner = Get-ChildItem $buildTools.FullName -Filter apksigner.bat | Select-Object -First 1
& $apksigner.FullName sign --ks $keyStore --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --out $apk $unsigned.FullName

$zipalign = Join-Path $buildTools.FullName "zipalign.exe"
if (Test-Path $zipalign) {
    & $zipalign -c -P 16 -v 4 $apk | Select-Object -Last 1
}

Write-Host "APK: $apk"
