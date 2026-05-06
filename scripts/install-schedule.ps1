# Registers (or replaces) a Windows Scheduled Task that runs the StatEdge
# nightly NBA sync at 04:00 local time.
#
# Run once from PowerShell:
#   .\scripts\install-schedule.ps1

$taskName = "StatEdge NBA Sync"
$scriptPath = "C:\Users\alfar\Projects\StatEdge\scripts\sync-nightly.ps1"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Daily -At 4am

# Settings: allow running on AC and battery, restart on failure, run as soon
# as possible if the machine was asleep at the trigger time.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 15)

# Run as the current interactive user, only when logged in (so npm and the
# .env credentials are available).
$principal = New-ScheduledTaskPrincipal -UserId $env:UserName -LogonType Interactive

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Pulls fresh NBA game logs from stats.nba.com into Neon every night at 4am." `
    -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "Next run: $(Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo | Select-Object -ExpandProperty NextRunTime)"
