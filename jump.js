'use strict';
// Bring an agent's chat to the front.
//
//   Claude    claude://code/continue?session=<local id>        (main.js)
//   Codex     codex://threads/<thread id>                      the app's own deep link
//   OpenCode  its window, then the chat's tab (UI Automation: the open chats are listed as links named "<letter> <title>")
//   others    the window of the app, or of the terminal running the CLI (its parent process chain)
//
// The PowerShell script reads its inputs from the environment (DOCK_EXES, DOCK_TITLE), never from interpolated text.
const { execFile } = require('child_process');
const { OTHERS } = require('./agents');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codexUrl = (id) => (THREAD_ID.test(String(id)) ? 'codex://threads/' + String(id).toLowerCase() : null);

/** Executable names (without .exe, lowercase) whose window holds this agent's chats. */
function exesOf(agentId) {
  if (agentId === 'codex') return ['chatgpt', 'codex'];
  const a = OTHERS.find((x) => x.id === agentId);
  return a ? a.exe.map((e) => e.replace(/\.exe$/i, '').toLowerCase()) : [];
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);' -Name W -Namespace N
$exes = @($env:DOCK_EXES -split ',' | Where-Object { $_ })
$procs = @(Get-Process | Where-Object { $exes -contains $_.ProcessName.ToLower() })
$h = [IntPtr]::Zero
foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { $h = $p.MainWindowHandle; break } }
if ($h -eq [IntPtr]::Zero -and $procs.Count -gt 0) {
  # a CLI: the window is the terminal it runs in
  $parent = @{}
  Get-CimInstance Win32_Process | ForEach-Object { $parent[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  foreach ($p in $procs) {
    $id = [int]$p.Id
    for ($i = 0; $i -lt 8 -and $parent.ContainsKey($id); $i++) {
      $id = $parent[$id]
      $q = Get-Process -Id $id
      if (-not $q) { break }
      # the desktop and system hosts are not where a CLI runs
      if (@('explorer', 'svchost', 'services', 'wininit', 'winlogon', 'userinit') -contains $q.ProcessName.ToLower()) { break }
      if ($q.MainWindowHandle -ne 0 -and $q.MainWindowTitle) { $h = $q.MainWindowHandle; break }
    }
    if ($h -ne [IntPtr]::Zero) { break }
  }
}
if ($h -eq [IntPtr]::Zero) { 'none'; exit }
if ([N.W]::IsIconic($h)) { [N.W]::ShowWindow($h, 9) | Out-Null }
[N.W]::SetForegroundWindow($h) | Out-Null
if ($env:DOCK_TITLE) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  $pattern = '^\S+ ' + [regex]::Escape($env:DOCK_TITLE) + '$'
  # Chromium builds its accessibility tree only after the first request, so the first look may find little
  for ($try = 0; $try -lt 8; $try++) {
    $links = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $hit = $null
    foreach ($e in $links) { if ($e.Current.Name -match $pattern) { $hit = $e; break } }
    if ($hit) {
      $pat = $null
      if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke() }
      break
    }
    if ($links.Count -gt 3 -and $try -ge 2) { break }
    Start-Sleep -Milliseconds 400
  }
}
'found'
`;

/** Bring the window of an app (or of the terminal of a CLI) forward; with `title` also open that chat's tab. Resolves true when a window was found. */
function focusWindow(exes, title, run = execFile) {
  if (!exes || !exes.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 15000, env: { ...process.env, DOCK_EXES: exes.join(','), DOCK_TITLE: title || '' } }, (err, out) => resolve(!err && /found/.test(String(out))));
  });
}

module.exports = { codexUrl, exesOf, focusWindow, SCRIPT, THREAD_ID };
