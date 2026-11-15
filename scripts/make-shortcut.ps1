# Creates "Agent HUD" shortcuts on the Desktop and in the Start menu.
# Ctrl+Alt+H starts it (or brings the window to the front when it is already running).
param([switch]$NoStartMenu)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Run 'npm install' first: $electron not found" }
$ws = New-Object -ComObject WScript.Shell
function New-Link($path) {
  $l = $ws.CreateShortcut($path)
  $l.TargetPath = $electron
  $l.Arguments = '.'
  $l.WorkingDirectory = $root
  $l.IconLocation = (Join-Path $root 'assets\icon.ico') + ',0'
  $l.Description = 'Agent HUD - working / waiting / done for every coding agent'
  $l.WindowStyle = 7
  $l.Save()
  $l
}
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { throw 'Could not find the Desktop folder' }
$d = New-Link (Join-Path $desktop 'Agent HUD.lnk')
$d.Hotkey = 'CTRL+ALT+H'; $d.Save()
"Desktop:    $($d.FullName)"
if (-not $NoStartMenu) {
  $sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'Agent HUD.lnk'
  $null = New-Link $sm
  "Start menu: $sm"
}
