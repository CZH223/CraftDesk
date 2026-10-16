# Click at a point in the CraftDesk window, for poking at the UI during development.
# Coordinates are in the same pixels as the capture-window.ps1 image.
# ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI and would mangle non-ASCII.
param(
  # "x,y" measured against the capture-window.ps1 image
  [Parameter(Mandatory = $true)][string]$At,
  # Vertical gap between the client origin and GetWindowRect on this box (237px,
  # frameless window at 150% scaling). Without it every click lands one row off.
  # If clicks miss on another machine, measure this once and change it here.
  [int]$OffsetY = 237,
  # Move the cursor without clicking: use it to see which element is hovered
  # and calibrate the offset.
  [switch]$HoverOnly
)

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Click {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

[void][Win32Click]::SetProcessDPIAware()

$parts = $At.Split(',')
if ($parts.Length -ne 2) { Write-Error "At must be 'x,y'"; exit 1 }
$relX = [int]$parts[0]
$relY = [int]$parts[1]

$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $proc) { Write-Error "CraftDesk window not found"; exit 1 }

$h = $proc.MainWindowHandle

# SetForegroundWindow on its own is routinely refused when the caller is not
# already the foreground app, and then the click lands on whatever window is
# on top instead. AttachThreadInput + an ALT tap defeats that lock.
$fg = [Win32Click]::GetForegroundWindow()
$fgThread = [Win32Click]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$myThread = [Win32Click]::GetCurrentThreadId()
[void][Win32Click]::AttachThreadInput($myThread, $fgThread, $true)
[void][Win32Click]::ShowWindow($h, 9)
[void][Win32Click]::BringWindowToTop($h)
[void][Win32Click]::SetForegroundWindow($h)
[Win32Click]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
[Win32Click]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
[void][Win32Click]::AttachThreadInput($myThread, $fgThread, $false)
Start-Sleep -Milliseconds 800

$r = New-Object Win32Click+RECT
[void][Win32Click]::GetWindowRect($h, [ref]$r)
$absX = $r.Left + $relX
$absY = $r.Top + $OffsetY + $relY

[void][Win32Click]::SetCursorPos($absX, $absY)
Start-Sleep -Milliseconds 250
if (-not $HoverOnly) {
  # LEFTDOWN | LEFTUP
  [Win32Click]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32Click]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
}

$fgNow = [Win32Click]::GetForegroundWindow()
Write-Output "clicked image($relX,$relY) -> screen($absX,$absY); foreground=$fgNow target=$h; winRect=$($r.Left),$($r.Top)-$($r.Right),$($r.Bottom)"
