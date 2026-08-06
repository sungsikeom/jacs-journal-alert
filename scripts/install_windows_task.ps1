$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runner = Join-Path $RepoRoot "scripts\run_local_acs_update.ps1"

Set-Location $RepoRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed or is not on PATH." }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Python is not installed or is not on PATH." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git is not installed or is not on PATH." }
if (-not (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe")) { throw "Google Chrome was not found." }

npm install

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
$Trigger = New-ScheduledTaskTrigger -Daily -At "09:00"
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName "Journal Alert Official Publisher Update" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Collect all journal metadata from official publisher pages using local Google Chrome" -Force

Unregister-ScheduledTask -TaskName "JACS Journal Alert ACS Update" -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Installed: Journal Alert Official Publisher Update (daily at 09:00)"
Write-Host "Run scripts\run_local_acs_update.ps1 once manually before relying on the schedule."
