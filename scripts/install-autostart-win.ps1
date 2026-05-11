# Install lol-tilt-bot to the Windows Startup folder so it runs silently at login.
# No administrator privileges required.
# Run: npm run install-autostart

$BotDir  = Split-Path -Parent $PSScriptRoot
$VbsSrc  = Join-Path $PSScriptRoot "start-hidden.vbs"

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) {
    Write-Error "node not found in PATH. Install Node.js >= 20 first."
    exit 1
}

$StartupDir = [Environment]::GetFolderPath('Startup')
$VbsDst     = Join-Path $StartupDir "lol-tilt-bot.vbs"

Copy-Item $VbsSrc $VbsDst -Force

Write-Host ""
Write-Host "lol-tilt-bot will now start silently at every login."
Write-Host "  Startup file: $VbsDst"
Write-Host "  Node:         $NodeBin"
Write-Host "  Bot:          $BotDir\src\index.js"
Write-Host ""
Write-Host "  Uninstall: npm run uninstall-autostart"
