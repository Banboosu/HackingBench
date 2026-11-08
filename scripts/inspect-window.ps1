param([Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId)
$ErrorActionPreference = 'Stop'
# Read-only GUI diagnostics for a specific process created by the caller.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BenchWindowInfo {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
$owned = Get-Process -Id $OwnedProcessId
$owned.Refresh()
$window = $owned.MainWindowHandle
if ($window -eq [IntPtr]::Zero) { throw 'Owned game has no main window handle.' }
# The game declares per-monitor-v2 awareness via the bridge plugin, so the
# physical client rectangle is the actual configured game resolution.
$previousDpi = [BenchWindowInfo]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
    $rect = New-Object BenchWindowInfo+Rect
    if (-not [BenchWindowInfo]::GetClientRect($window, [ref]$rect)) { throw 'Could not read owned game client rectangle.' }
    $dpi = [BenchWindowInfo]::GetDpiForWindow($window)
    if ($dpi -eq 0) { $dpi = 96 }
    $scale = $dpi / 96.0
    $physicalWidth = $rect.Right - $rect.Left
    $physicalHeight = $rect.Bottom - $rect.Top
    [pscustomobject]@{
        pid = $OwnedProcessId
        visible = [BenchWindowInfo]::IsWindowVisible($window)
        minimized = [BenchWindowInfo]::IsIconic($window)
        width = $physicalWidth
        height = $physicalHeight
        physicalWidth = $physicalWidth
        physicalHeight = $physicalHeight
        dpi = $dpi
        scale = $scale
    } | ConvertTo-Json -Compress
} finally {
    if ($previousDpi -ne [IntPtr]::Zero) { [void][BenchWindowInfo]::SetThreadDpiAwarenessContext($previousDpi) }
}
