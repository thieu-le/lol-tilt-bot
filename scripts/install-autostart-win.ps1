# Install lol-tilt-bot as a Windows Task Scheduler task that runs silently at login.
# Run once: npm run install-autostart
# Requires PowerShell running as Administrator (or a standard user with Task Scheduler write access).

$BotDir  = Split-Path -Parent $PSScriptRoot
$VbsPath = Join-Path $PSScriptRoot "start-hidden.vbs"

$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) {
    Write-Error "node not found in PATH. Install Node.js >= 20 first."
    exit 1
}

$TaskName = "lol-tilt-bot"

$Action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
$Trigger  = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
              -ExecutionTimeLimit 0 `
              -MultipleInstances IgnoreNew `
              -DisallowStartIfOnBatteries $false `
              -StopIfGoingOnBatteries $false

# Remove any existing registration first so re-running this script is safe.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    $Trigger `
    -Settings   $Settings `
    -Description "lol-tilt-bot Discord bot" `
    -Force | Out-Null

Write-Host ""
Write-Host "lol-tilt-bot will now start silently at login."
Write-Host "  Node:     $NodeBin"
Write-Host "  Bot:      $BotDir\src\index.js"
Write-Host ""
Write-Host "  Start now:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop now:   Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host "  Uninstall:  npm run uninstall-autostart"
