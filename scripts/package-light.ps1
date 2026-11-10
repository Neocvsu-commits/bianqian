param()
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageInfo = Get-Content -LiteralPath (Join-Path $projectPath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$stagePath = Join-Path $projectPath '.work\webview-assets'
$releasePath = Join-Path $projectPath 'release\便签 Demo 31'
$sourceFiles = @('index.html', 'styles.css', 'app.js', 'paper-motion.js', 'paper-audio.js', 'paper-text.js', 'desktop\note-model.js', 'desktop\webview-bridge.js', 'desktop\backend.html', 'desktop\backend.js', 'assets\icon.png')
foreach ($sourceFile in $sourceFiles) {
    $source = Join-Path $projectPath $sourceFile
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少源文件：$sourceFile" }
    $target = Join-Path $stagePath $sourceFile
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
}
$manifestPath = Join-Path $projectPath 'native\Cargo.toml'
$buildMessages = & cargo build --release --offline --locked --message-format=json-render-diagnostics --manifest-path $manifestPath
if ($LASTEXITCODE -ne 0) { throw '轻量版构建失败。' }
$artifacts = @($buildMessages | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' })
$builtExecutable = Join-Path $projectPath 'native\target\release\bianqian.exe'
if (-not (Test-Path -LiteralPath $builtExecutable -PathType Leaf)) { throw '构建未生成便签程序。' }
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
$executablePath = Join-Path $releasePath '便签.exe'
Copy-Item -LiteralPath $builtExecutable -Destination $executablePath -Force
& (Join-Path $PSScriptRoot 'set-app-resources.ps1') -ExecutablePath $executablePath -IconPath (Join-Path $projectPath 'assets\icon.ico') -ProductName $packageInfo.productName -ProductVersion $packageInfo.version
Copy-Item -LiteralPath (Join-Path $projectPath 'README.md') -Destination $releasePath -Force
Copy-Item -LiteralPath (Join-Path $projectPath 'screenshots') -Destination $releasePath -Recurse -Force

# Use the actual Windows compiler artifacts; metadata also resolves unrelated platforms.
$licensePath = Join-Path $releasePath 'ThirdPartyLicenses'
New-Item -ItemType Directory -Path $licensePath -Force | Out-Null
$dependencyManifests = @($artifacts.manifest_path | Where-Object { $_ -and ([IO.Path]::GetFullPath($_) -ne $manifestPath) } | Sort-Object -Unique)
if ($dependencyManifests.Count -eq 0) { throw '构建没有返回依赖清单。' }
$notices = foreach ($dependencyManifest in $dependencyManifests) {
    $manifestText = Get-Content -LiteralPath $dependencyManifest -Raw -Encoding UTF8
    $dependencyName = [regex]::Match($manifestText, '(?m)^name\s*=\s*"([^"]+)"').Groups[1].Value
    $dependencyVersion = [regex]::Match($manifestText, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
    $dependencyLicense = [regex]::Match($manifestText, '(?m)^license\s*=\s*"([^"]+)"').Groups[1].Value
    $dependencyRepository = [regex]::Match($manifestText, '(?m)^repository\s*=\s*"([^"]+)"').Groups[1].Value
    $packageDir = Split-Path -Parent $dependencyManifest
    $texts = Get-ChildItem -LiteralPath $packageDir -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE)([._-].*)?$' }
    $licenseFile = [regex]::Match($manifestText, '(?m)^license-file\s*=\s*"([^"]+)"').Groups[1].Value
    if ($licenseFile -and (Test-Path -LiteralPath (Join-Path $packageDir $licenseFile) -PathType Leaf)) { $texts = @($texts) + (Get-Item -LiteralPath (Join-Path $packageDir $licenseFile)) }
    if ($texts) {
        $destination = Join-Path $licensePath ($dependencyName + '-' + $dependencyVersion)
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        foreach ($license in $texts) { Copy-Item -LiteralPath $license.FullName -Destination $destination -Force }
    }
    "$dependencyName $dependencyVersion | $dependencyLicense | $dependencyRepository"
}
[IO.File]::WriteAllLines((Join-Path $licensePath 'DEPENDENCIES.txt'), [string[]]$notices, (New-Object Text.UTF8Encoding($false)))
$zipPath = Join-Path $projectPath ('release\bianqian-v' + $packageInfo.version + '-Windows-x64.zip')
Compress-Archive -LiteralPath $releasePath -DestinationPath $zipPath -CompressionLevel Optimal -Force
$hasher = [Security.Cryptography.SHA256]::Create()
$archiveStream = [IO.File]::OpenRead($zipPath)
try { $hash = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
finally { $archiveStream.Dispose(); $hasher.Dispose() }
[IO.File]::WriteAllText(($zipPath + '.sha256'), ($hash + '  ' + [IO.Path]::GetFileName($zipPath) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output ("轻量版打包完成：{0}" -f $executablePath)
Write-Output ("EXE：{0:N2} MB；ZIP：{1:N2} MB" -f ((Get-Item -LiteralPath $executablePath).Length / 1MB), ((Get-Item -LiteralPath $zipPath).Length / 1MB))
