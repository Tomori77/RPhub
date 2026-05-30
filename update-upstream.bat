@echo off
chcp 65001 >nul
setlocal
title RP-Hub 一键更新

set "RP_HUB_UPDATER=%~f0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $bat=$env:RP_HUB_UPDATER; $tmp=Join-Path $env:TEMP ('rp-hub-updater-' + [guid]::NewGuid().ToString('N') + '.ps1'); try { $lines=New-Object System.Collections.Generic.List[string]; foreach($line in [IO.File]::ReadLines($bat, [Text.Encoding]::UTF8)){ if($line.StartsWith('rem ps::')){ $lines.Add($line.Substring(8)) } }; [IO.File]::WriteAllLines($tmp, $lines, [Text.UTF8Encoding]::new($true)); powershell -NoProfile -ExecutionPolicy Bypass -File $tmp; exit $LASTEXITCODE } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }"
set "RP_HUB_EXIT=%ERRORLEVEL%"

if not "%RP_HUB_NO_PAUSE%"=="1" (
    echo.
    pause
)
exit /b %RP_HUB_EXIT%

rem ps::$ErrorActionPreference = 'Stop'
rem ps::$ProgressPreference = 'SilentlyContinue'
rem ps::
rem ps::[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
rem ps::$repoZipUrl = 'https://codeload.github.com/STA1N156/RP-Hub/zip/refs/heads/main'
rem ps::$root = (Resolve-Path (Split-Path -Parent $env:RP_HUB_UPDATER)).Path
rem ps::$updaterName = Split-Path -Leaf $env:RP_HUB_UPDATER
rem ps::$preserveRootNames = @('DB', 'work.js', '_worker.js', '.git', $updaterName)
rem ps::
rem ps::function Test-PreservedRootName {
rem ps::    param([string] $Name)
rem ps::    foreach ($preserved in $preserveRootNames) {
rem ps::        if ($Name -ieq $preserved) {
rem ps::            return $true
rem ps::        }
rem ps::    }
rem ps::    return $false
rem ps::}
rem ps::
rem ps::function Show-ProgressBar {
rem ps::    param([int] $Percent, [string] $Text)
rem ps::    $width = 30
rem ps::    $filled = [Math]::Floor($Percent * $width / 100)
rem ps::    $empty = $width - $filled
rem ps::    $bar = ('█' * $filled) + ('░' * $empty)
rem ps::    Write-Host -NoNewline ("`r[$bar] $Percent%  $Text" + (' ' * 24))
rem ps::    if ($Percent -ge 100) {
rem ps::        Write-Host ''
rem ps::    }
rem ps::}
rem ps::
rem ps::function Fail-Friendly {
rem ps::    param([string] $Message)
rem ps::    Write-Host ''
rem ps::    Write-Host "更新失败：$Message" -ForegroundColor Red
rem ps::}
rem ps::
rem ps::function Download-WithRetry {
rem ps::    param([string] $Url, [string] $OutFile)
rem ps::    $lastError = $null
rem ps::    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
rem ps::        try {
rem ps::            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
rem ps::            return
rem ps::        } catch {
rem ps::            $lastError = $_
rem ps::            if ($attempt -lt 3) {
rem ps::                Start-Sleep -Seconds (2 * $attempt)
rem ps::            }
rem ps::        }
rem ps::    }
rem ps::    throw $lastError
rem ps::}
rem ps::
rem ps::$tempBase = Join-Path ([System.IO.Path]::GetTempPath()) ("rp-hub-upstream-" + [System.Guid]::NewGuid().ToString('N'))
rem ps::$zipPath = Join-Path $tempBase 'source.zip'
rem ps::$extractPath = Join-Path $tempBase 'extract'
rem ps::
rem ps::Write-Host ''
rem ps::Write-Host '正在更新 RP-Hub，请稍等...'
rem ps::Show-ProgressBar -Percent 0 -Text '准备中'
rem ps::
rem ps::try {
rem ps::    New-Item -ItemType Directory -Path $tempBase, $extractPath -Force | Out-Null
rem ps::    Show-ProgressBar -Percent 15 -Text '下载最新版本'
rem ps::    Download-WithRetry -Url $repoZipUrl -OutFile $zipPath
rem ps::    Show-ProgressBar -Percent 45 -Text '解压文件'
rem ps::    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
rem ps::    $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
rem ps::    if (-not $sourceRoot) {
rem ps::        throw '没有找到下载后的项目文件。'
rem ps::    }
rem ps::    Show-ProgressBar -Percent 65 -Text '整理文件'
rem ps::    $removeTargets = Get-ChildItem -LiteralPath $root -Force |
rem ps::        Where-Object { -not (Test-PreservedRootName $_.Name) }
rem ps::    $copyTargets = Get-ChildItem -LiteralPath $sourceRoot.FullName -Force |
rem ps::        Where-Object { -not (Test-PreservedRootName $_.Name) }
rem ps::    Show-ProgressBar -Percent 80 -Text '更新文件'
rem ps::    foreach ($target in $removeTargets) {
rem ps::        Remove-Item -LiteralPath $target.FullName -Recurse -Force
rem ps::    }
rem ps::    foreach ($item in $copyTargets) {
rem ps::        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $root $item.Name) -Recurse -Force
rem ps::    }
rem ps::    Show-ProgressBar -Percent 100 -Text '完成'
rem ps::} catch {
rem ps::    Fail-Friendly ($_.Exception.Message)
rem ps::    exit 1
rem ps::} finally {
rem ps::    if (Test-Path -LiteralPath $tempBase) {
rem ps::        Remove-Item -LiteralPath $tempBase -Recurse -Force -ErrorAction SilentlyContinue
rem ps::    }
rem ps::}
