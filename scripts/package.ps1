param(
    [string]$RuntimePath = 'F:\AI\Tools\Windows Tools\Folio\node_modules\electron\dist'
)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releasePath = Join-Path $projectPath 'release\便签 Demo 21'
$appPath = Join-Path $releasePath 'resources\app'
$sourceFiles = @('index.html', 'styles.css', 'app.js', 'paper-motion.js', 'paper-audio.js', 'paper-text.js', 'package.json', 'desktop\main.cjs', 'desktop\preload.cjs', 'assets\icon.png', 'assets\icon.ico')
$executablePath = Join-Path $releasePath '便签.exe'
$iconPath = Join-Path $projectPath 'assets\icon.ico'
$resourceScript = Join-Path $PSScriptRoot 'set-app-resources.ps1'

foreach ($sourceFile in $sourceFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectPath $sourceFile) -PathType Leaf)) {
        throw "缺少源文件：$sourceFile"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimePath 'electron.exe') -PathType Leaf)) {
    throw "没有找到 Electron 运行时：$RuntimePath"
}
if (-not (Test-Path -LiteralPath $resourceScript -PathType Leaf)) {
    throw "缺少 Windows 图标与名称写入脚本：$resourceScript"
}
$packageInfo = Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$productVersion = [string]$packageInfo.version
if ($productVersion -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') {
    throw "package.json 中的版本号不适合写入 Windows 资源：$productVersion"
}

New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
Get-ChildItem -LiteralPath $RuntimePath -Force | Where-Object { $_.Name -ne 'electron.exe' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $releasePath -Recurse -Force
}
foreach ($sourceFile in $sourceFiles) {
    $destinationPath = Join-Path $appPath $sourceFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectPath $sourceFile) -Destination $destinationPath -Force
}
Copy-Item -LiteralPath (Join-Path $RuntimePath 'electron.exe') -Destination $executablePath -Force
& $resourceScript -ExecutablePath $executablePath -IconPath $iconPath -ProductName $packageInfo.productName -ProductVersion $productVersion
$readmePath = Join-Path $projectPath 'README.md'
if (Test-Path -LiteralPath $readmePath) {
    Copy-Item -LiteralPath $readmePath -Destination (Join-Path $releasePath 'README.md') -Force
}
Write-Output "打包完成：$executablePath（已嵌入图标与产品信息）"
