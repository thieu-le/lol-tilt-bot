# Remove lol-tilt-bot from the Windows Startup folder.
# Run: npm run uninstall-autostart

$StartupDir = [Environment]::GetFolderPath('Startup')
$VbsDst     = Join-Path $StartupDir "lol-tilt-bot.vbs"

if (-not (Test-Path $VbsDst)) {
    Write-Host "Autostart not installed ($VbsDst not found)."
    exit 0
}

Remove-Item $VbsDst -Force
Write-Host "lol-tilt-bot autostart removed. The bot will no longer start at login."
