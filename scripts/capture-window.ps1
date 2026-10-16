# Capture the CraftDesk main window for a visual check.
# Uses PrintWindow so the result is the window's own content, independent of
# whatever else happens to be on screen, and nothing else is captured.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI and would mangle non-ASCII.
param(
  [string]$OutFile = "$env:TEMP\craftdesk-window.png",
  # Only capture the instance whose command line contains this string,
  # so a dev instance started with its own --user-data-dir can be picked out.
  [string]$Match = ""
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# Must run before any coordinate query: without it GetWindowRect returns
# DPI-virtualized values and the capture comes out scaled on displays above 100%.
[void][Win32Cap]::SetProcessDPIAware()

$procs = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }

if ($Match) {
  $procs = $procs | Where-Object {
    (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -like "*$Match*"
  }
}

$proc = $procs | Select-Object -First 1

if (-not $proc) { Write-Error "CraftDesk window not found"; exit 1 }

$h = $proc.MainWindowHandle
# SW_SHOWNORMAL then SW_RESTORE, in case the window is minimized
[void][Win32Cap]::ShowWindow($h, 1)
[void][Win32Cap]::ShowWindow($h, 9)
[void][Win32Cap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

# GetWindowRect can return a zeroed rect right after a restore, so retry
$r = New-Object Win32Cap+RECT
$w = 0
$ht = 0
for ($i = 0; $i -lt 20; $i++) {
  [void][Win32Cap]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $ht = $r.Bottom - $r.Top
  if ($w -gt 0 -and $ht -gt 0) { break }
  Start-Sleep -Milliseconds 300
}
if ($w -le 0 -or $ht -le 0) { Write-Error "Invalid window rect for handle $h"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2, required for Chromium/Electron surfaces
$ok = [Win32Cap]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) {
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
}

$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "$OutFile ($w x $ht)"
