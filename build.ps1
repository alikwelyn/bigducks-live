param(
    [string]$Version = "0.1.1",
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$ResourcePrefix = Join-Path $PSScriptRoot "cmd\bigducks\rsrc"
$ResourceFile = $ResourcePrefix + "_windows_amd64.syso"
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $PSScriptRoot "dist"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$OutputPath = Join-Path $OutputDirectory "BigDucks.exe"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must use major.minor.patch"
}

go test ./...
if ($LASTEXITCODE -ne 0) {
    throw "Go tests failed"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

try {
    go run github.com/tc-hib/go-winres@v0.3.3 simply `
        --arch amd64 `
        --out $ResourcePrefix `
        --manifest gui `
        --product-version "$Version.0" `
        --file-version "$Version.0" `
        --file-description "BIG DUCKS LIVE - proteção para lives do Discord" `
        --product-name "BIG DUCKS LIVE" `
        --copyright "Copyright (c) 2026 BIG DUCKS contributors" `
        --original-filename "BigDucks.exe" `
        --icon (Join-Path $PSScriptRoot "imgs\big-ducks.png")
    if ($LASTEXITCODE -ne 0) {
        throw "Windows resource generation failed"
    }

    $LinkerFlags = "-s -w -H=windowsgui -X github.com/alikwelyn/bigducks-live/internal/buildinfo.Version=$Version"
    go build -trimpath -ldflags $LinkerFlags -o $OutputPath ./cmd/bigducks
    if ($LASTEXITCODE -ne 0) {
        throw "Go build failed"
    }
}
finally {
    Remove-Item -LiteralPath $ResourceFile -Force -ErrorAction SilentlyContinue
}

$Artifact = Get-Item -LiteralPath $OutputPath
$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
Write-Output ("Built: {0} ({1} bytes)" -f $Artifact.FullName, $Artifact.Length)
Write-Output ("SHA256: {0}" -f $Hash)
