# Remove the lol-tilt-bot Task Scheduler task.
# Run: npm run uninstall-autostart

$TaskName = "lol-tilt-bot"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "Autostart not installed (task '$TaskName' not found)."
    exit 0
}

Stop-ScheduledTask  -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "lol-tilt-bot autostart removed. The bot will no longer start at login."
