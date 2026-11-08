using BepInEx;
using BepInEx.Hacknet;
using System;
using System.Runtime.InteropServices;

namespace HnpfMcpBridge;

/// <summary>
/// Hacknet/FNA 17.2 ships SDL2 2.0.5, which is DPI-unaware. On a scaled
/// desktop that makes a logical 1920x1080 window occupy 3840x2160 physical
/// pixels and can push it off-screen. Declare per-monitor-v2 awareness before
/// the first game window exists so Settings.txt pixels map 1:1 to pixels.
///
/// This is a separate BepInEx plugin in the bridge assembly, so it runs before
/// Game1 creates its GraphicsDeviceManager and before any game window exists.
/// </summary>
[BepInPlugin(Guid, Name, Version)]
public sealed class DpiAwarenessPlugin : HacknetPlugin
{
    public const string Guid = "com.HackingBench.DpiAwareness";
    public const string Name = "HackingBench DPI Awareness";
    public const string Version = "1.0.0";

    public override bool Load()
    {
        DpiAwareness.TryApply(Log);
        return true;
    }
}

internal static class DpiAwareness
{
    private const int PerMonitorAwareV2 = -4;
    private const int PerMonitorAware = -3;
    private const int SystemAware = -2;
    private static int _attempted;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    public static void TryApply(BepInEx.Logging.ManualLogSource log)
    {
        // The first caller wins. Game1 construction must never throw because
        // the manifest already declared awareness or Windows is too old.
        if (Interlocked.Exchange(ref _attempted, 1) != 0) return;
        try
        {
            foreach (var context in new[] { PerMonitorAwareV2, PerMonitorAware, SystemAware })
            {
                if (!SetProcessDpiAwarenessContext(new IntPtr(context))) continue;
                Log(log, $"DPI awareness set to context {context} (per-monitor aware).");
                return;
            }
            // Windows 8.1 fallback (1 = system aware, 2 = per-monitor aware).
            if (SetProcessDpiAwareness(2) == 0)
            {
                Log(log, "DPI awareness set to per-monitor (shcore).");
                return;
            }
            if (SetProcessDPIAware())
            {
                Log(log, "DPI awareness set to system aware (legacy).");
                return;
            }
            Log(log, "DPI awareness was already declared by the host or could not be changed.");
        }
        catch (EntryPointNotFoundException)
        {
            try
            {
                if (SetProcessDPIAware()) Log(log, "DPI awareness set to system aware (legacy).");
            }
            catch (Exception ex) { Log(log, $"DPI awareness unavailable: {ex.Message}"); }
        }
        catch (Exception ex)
        {
            Log(log, $"DPI awareness could not be set: {ex.Message}");
        }
    }

    private static void Log(BepInEx.Logging.ManualLogSource log, string message)
    {
        if (log != null) log.LogInfo(message);
        else Console.WriteLine($"[{DpiAwarenessPlugin.Name}] {message}");
    }
}
