param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$IconPath,
    [string]$ProductName = '便签',
    [string]$ProductVersion = '0.13.0'
)
$ErrorActionPreference = 'Stop'

try {
    $executableFile = [IO.Path]::GetFullPath($ExecutablePath)
    $iconFile = [IO.Path]::GetFullPath($IconPath)
    if (-not (Test-Path -LiteralPath $executableFile -PathType Leaf)) {
        throw "没有找到要写入的 EXE：$executableFile"
    }
    if (-not (Test-Path -LiteralPath $iconFile -PathType Leaf)) {
        throw "没有找到 ICO 图标：$iconFile"
    }
    $sourcePath = Join-Path $PSScriptRoot 'AppResources.cs'
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "没有找到原生资源写入代码：$sourcePath"
    }
    if (-not ('BianQian.NativeAppResources' -as [type])) {
        Add-Type -Path $sourcePath
    }
    $resourceResult = [BianQian.NativeAppResources]::Write($executableFile, $iconFile, $ProductName, $ProductVersion)
    Write-Output "EXE 资源已写入并核对：$($resourceResult.ProductName) $($resourceResult.ProductVersion)，$($resourceResult.IconFrames) 帧图标，$($resourceResult.IconGroups) 个图标组。"
} catch {
    throw "EXE 图标与产品资源写入失败：$($_.Exception.GetBaseException().Message)"
}
