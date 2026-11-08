using Hacknet;
using Hacknet.PlatformAPI.Storage;
using HarmonyLib;
using System.Reflection;

namespace HnpfMcpBridge;

// Replaces the extension-only upstream menu handler in the benchmark build.
[HarmonyPatch(typeof(MainMenu), "Update")]
public static class MenuExecutor
{
    public static void Postfix(MainMenu __instance)
    {
        var pipe = HnpfMcpBridgePlugin.Pipe;
        if (pipe == null) return;
        int remaining = 4;
        while (remaining-- > 0 && pipe.TryDequeueRequest(out var queued))
        {
            var req = queued.Request;
            try
            {
                object result;
                if (req.Method == "menu.status")
                    result = new Dictionary<string, object> { ["phase"] = "menu", ["saveRoot"] = SaveRoot() };
                else if (req.Method == "menu.start_vanilla")
                {
                    var root = SaveRoot();
                    if (SaveFileManager.StorageMethods.Any(s => s.GetType().Name == "SteamCloudStorageMethod"))
                        throw new InvalidOperationException("Cloud storage is active; refusing benchmark start.");
                    var local = SaveFileManager.StorageMethods.FirstOrDefault(s => s.GetType().Name == "LocalDocumentsStorageMethod");
                    var actual = local?.GetType().GetProperty("FullFolderPath", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(local) as string;
                    if (actual == null || !string.Equals(Path.GetFullPath(actual).TrimEnd('\\','/'), root.TrimEnd('\\','/'), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Save isolation verification failed.");
                    var login = typeof(MainMenu).GetField("loginScreen", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(__instance);
                    var start = login?.GetType().GetField("StartNewGameForUsernameAndPass", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(login) as Action<string, string>;
                    if (start == null) throw new InvalidOperationException("Vanilla new-game delegate is unavailable.");
                    var username = req.Params != null && req.Params.TryGetValue("username", out var u) ? u?.ToString() : null;
                    if (string.IsNullOrEmpty(username) || !System.Text.RegularExpressions.Regex.IsMatch(username, "^bench[a-z0-9]{8,20}$"))
                        throw new ArgumentException("Invalid benchmark account name.");
                    // Same callback as the original New Game UI. No tutorial skipping, debug flags or DLC acceleration.
                    start(username, Guid.NewGuid().ToString("N"));
                    result = new Dictionary<string, object> { ["ok"] = true, ["username"] = username, ["mode"] = "vanilla" };
                }
                else throw new ArgumentException("Not available in menu; enter the game first.");
                pipe.PushResponse(RpcResponse.Ok(req, result).ToJsonLine(), queued.Client);
            }
            catch (Exception ex) { pipe.PushResponse(RpcResponse.Fail(req, 500, ex.Message).ToJsonLine(), queued.Client); }
        }
    }

    private static string SaveRoot()
    {
        var root = Environment.GetEnvironmentVariable("HACKINGBENCH_SAVE_DIR");
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathRooted(root))
            throw new InvalidOperationException("HACKINGBENCH_SAVE_DIR must be an absolute path.");
        return Path.GetFullPath(root);
    }
}
