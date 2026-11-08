using Hacknet;
using HarmonyLib;
using System.Globalization;
using Microsoft.Xna.Framework.Graphics;

namespace HnpfMcpBridge;

[HarmonyPatch(typeof(Executor), "Execute")]
public static class BenchDispatchPatch
{
    public static bool Prefix(OS os, RpcRequest req, ref object __result)
    {
        if (!req.Method.StartsWith("bench.", StringComparison.Ordinal)) return true;
        __result = Executor.DispatchBench(os, req);
        return false;
    }
}

public static partial class Executor
{
    public static object DispatchBench(OS os, RpcRequest req)
    {
        switch (req.Method)
        {
            case "bench.screen":
            {
                var state = (Dictionary<string, object>)GetState(os);
                var result = new Dictionary<string, object>();
                foreach (var key in new[] { "connectedIP", "connectedName", "thisComputerIP", "ramFree", "ramTotal", "trace" })
                    result[key] = state[key];
                result["booting"] = os.bootingUp;
                result["inputEnabled"] = os.inputEnabled;
                result["prompt"] = os.terminal.prompt;
                result["awaitingInput"] = os.terminal.preventingExecution && os.terminal.usingTabExecution && !os.bootingUp;
                result["terminal"] = TerminalHistory(os, 60);
                var tutorial = os.exes.OfType<AdvancedTutorial>().FirstOrDefault();
                if (tutorial != null && os.ram.visible && tutorial.visible) result["tutorial"] = new Dictionary<string, object> {
                    ["text"] = tutorial.renderText,
                    ["canContinue"] = tutorial.state == 0 && tutorial.CanActivateFirstStep,
                    ["canHint"] = !(tutorial.state == 0 && tutorial.CanActivateFirstStep) && tutorial.hintButtonText != null,
                    ["hint"] = tutorial.hintTextFadeTimer > 0 ? tutorial.hintButtonText : null,
                };
                // No node IDs, hidden nodes, files, flags, mission solutions or credentials.
                var visible = new List<object>();
                var map = (Dictionary<string, object>)GetNetworkMap(os, true);
                foreach (var n in (List<object>)map["nodes"])
                {
                    var node = (Dictionary<string, object>)n;
                    if (node["visible"] is bool v && v)
                        visible.Add(new Dictionary<string, object> { ["name"] = node["name"], ["ip"] = node["ip"], ["connected"] = node["connected"] });
                }
                result["network"] = visible;
                result["processes"] = GetProcesses(os);
                return result;
            }
            case "bench.command":
            {
                var cmd = Str(req.Params, "cmd");
                if (string.IsNullOrWhiteSpace(cmd) || cmd.Length > 256) throw new ArgumentException("Invalid command length.");
                foreach (var ch in cmd)
                    if (char.IsControl(ch) || (char.IsWhiteSpace(ch) && ch != ' ') || char.GetUnicodeCategory(ch) == UnicodeCategory.Format || "&|;`$()<>\\:".Contains(ch))
                        throw new ArgumentException("Command contains forbidden syntax.");
                if (os.bootingUp || !os.inputEnabled) throw new InvalidOperationException("Game input is not ready; use hn_wait.");
                if (os.terminal.preventingExecution) throw new InvalidOperationException("A program is awaiting input or busy. Check hn_screen and use hn_input if prompted.");
                return ExecuteCommand(os, cmd); // Includes upstream AllowedCommands policy.
            }
            case "bench.input":
            {
                if (os.bootingUp || !os.terminal.preventingExecution || !os.terminal.usingTabExecution)
                    throw new InvalidOperationException("No interactive terminal prompt is waiting for input.");
                var text = Str(req.Params, "text") ?? "";
                if (text.Length > 256 || text.Any(c => char.IsControl(c) || char.GetUnicodeCategory(c) == UnicodeCategory.Format))
                    throw new ArgumentException("Invalid prompt input.");
                // Mirror the input-only half of Terminal.executeLine. NEVER dispatch as a command,
                // even if a background login thread clears preventingExecution during this request.
                os.terminal.writeLine(os.terminal.prompt + (Hacknet.Gui.TextBox.MaskingText ? new string('*', text.Length) : text));
                os.terminal.lastRunCommand = text;
                os.terminal.runCommands.Add(text);
                os.terminal.currentLine = "";
                return new Dictionary<string, object> { ["ok"] = true, ["note"] = "Prompt input submitted, not executed as a command." };
            }
            case "bench.tutorial":
            {
                var tutorial = os.exes.OfType<AdvancedTutorial>().FirstOrDefault();
                if (tutorial == null || !os.ram.visible || !tutorial.visible) throw new InvalidOperationException("Tutorial is not visible.");
                var canContinue = tutorial.state == 0 && tutorial.CanActivateFirstStep;
                var action = Str(req.Params, "action");
                // Exactly the same guards and effects as AdvancedTutorial.Draw's Continue/Hint buttons.
                // This is not a generic advanceState API: all command-driven steps remain untouched.
                if (action == "continue" && canContinue) tutorial.advanceState();
                else if (action == "hint" && !canContinue && tutorial.hintButtonText != null) tutorial.hintTextFadeTimer = 9f;
                else throw new InvalidOperationException("That tutorial button is not currently available.");
                return new Dictionary<string, object> { ["ok"] = true };
            }
            case "bench.mail":
            {
                var box = PlayerInbox(os);
                int index = 0;
                var mails = new List<object>();
                foreach (var file in box.files) mails.Add(new Dictionary<string, object> { ["id"] = index++, ["subject"] = file.name });
                var action = Str(req.Params, "action") ?? "list";
                if (action == "list") return new Dictionary<string, object> { ["mails"] = mails };
                if (action != "read") throw new ArgumentException("Use list or read.");
                var id = IntParam(req.Params, "id");
                if (id < 0 || id >= box.files.Count) throw new ArgumentException("Mail ID not found.");
                var mail = box.files[id];
                var parts = mail.data.Split(MailSplitDelims, StringSplitOptions.None);
                return new Dictionary<string, object> { ["id"] = id, ["subject"] = mail.name,
                    ["sender"] = parts.Length > 1 ? parts[1].Trim() : "", ["body"] = parts.Length > 3 ? string.Join("\n", parts.Skip(3)) : mail.data };
            }
            case "bench.reply":
            {
                var box = PlayerInbox(os);
                var id = IntParam(req.Params, "id");
                if (id < 0 || id >= box.files.Count) throw new ArgumentException("Mail ID not found.");
                var parts = box.files[id].data.Split(MailSplitDelims, StringSplitOptions.None);
                var sender = parts.Length > 1 ? parts[1].Trim() : "";
                // The original mission checks, including sender verification. Do not reveal hidden failed goals.
                try { return MissionSubmit(os, sender, Str(req.Params, "answer") ?? "complete"); }
                catch { return new Dictionary<string, object> { ["ok"] = false, ["message"] = "Reply not accepted. Check the email instructions and your work." }; }
            }
            case "bench.hub":
            {
                if (os.connectedComp == null) throw new ArgumentException("Connect to a mission hub first.");
                if ((Str(req.Params, "action") ?? "list") == "list") return HubList(os, os.connectedComp.ip);
                var id = Str(req.Params, "id");
                if (string.IsNullOrEmpty(id) || id.Length > 128) throw new ArgumentException("Invalid mission listing ID.");
                return HubAccept(os, os.connectedComp.ip, id);
            }
            case "bench.judge":
            {
                var source = os.currentMission?.reloadGoalsSourceFile ?? "";
                // The shipped end-of-game email mission; never accept the agent's claim of victory.
                var file = Path.GetFileName(source.Replace('\\', '/'));
                return new Dictionary<string, object> {
                    ["completed"] = string.Equals(file, "CreditsMission.xml", StringComparison.OrdinalIgnoreCase) || string.Equals(file, "CreditsMission_p.xml", StringComparison.OrdinalIgnoreCase),
                    ["missionSource"] = source, ["flags"] = Safe(os.Flags?.Flags),
                    ["saveRoot"] = Environment.GetEnvironmentVariable("HACKINGBENCH_SAVE_DIR")
                };
            }
            case "bench.capture":
            {
                var device = os.ScreenManager.Game.GraphicsDevice;
                var pp = device.PresentationParameters;
                var width = pp.BackBufferWidth; var height = pp.BackBufferHeight;
                if (width <= 0 || height <= 0 || (long)width * height > 4096L * 2160L) throw new InvalidOperationException("Game framebuffer is too large.");
                var pixels = new Microsoft.Xna.Framework.Color[width * height];
                device.GetBackBufferData(pixels);
                using var texture = new Texture2D(device, width, height);
                texture.SetData(pixels);
                using var stream = new MemoryStream();
                texture.SaveAsPng(stream, width, height);
                return new Dictionary<string, object> { ["mimeType"] = "image/png", ["data"] = Convert.ToBase64String(stream.ToArray()) };
            }
            default: throw new ArgumentException("Unknown benchmark method.");
        }
    }
    private static Folder PlayerInbox(OS os)
    {
        var accounts = GetMailAccountsFolder(os.netMap.mailServer);
        var username = os.SaveUserAccountName;
        var user = accounts?.folders?.FirstOrDefault(f => string.Equals(f.name, username, StringComparison.OrdinalIgnoreCase));
        var inbox = user?.folders?.FirstOrDefault(f => string.Equals(f.name, "inbox", StringComparison.OrdinalIgnoreCase));
        if (inbox == null) throw new InvalidOperationException("Player inbox is not ready. Use hn_screen or progress through the tutorial.");
        return inbox;
    }
}
