using Hacknet;
using HarmonyLib;
using System.Reflection;
using System.Reflection.Emit;
using System.Threading;

namespace HnpfMcpBridge;

// Presentation-only startup option. Preserve all vanilla initialization and
// tutorial creation; GameSession dismisses that tutorial via normal `kill PID`.
// Do not change DebugGoFast, game time, program timers or subsequent reboots.
[HarmonyPatch(typeof(IntroTextModule), MethodType.Constructor, new[] { typeof(Microsoft.Xna.Framework.Rectangle), typeof(OS) })]
public static class IntroStoryPatch
{
    private static int skipNextIntro = Environment.GetEnvironmentVariable("HACKINGBENCH_SKIP_INTRO") == "1" ? 1 : 0;

    public static void Postfix(IntroTextModule __instance)
    {
        if (Interlocked.Exchange(ref skipNextIntro, 0) != 1) return;
        // Same presentation completion bit used by the game's no-intro path.
        // OS.Update still performs the normal boot transition/completeReboot.
        __instance.complete = true;
        Console.WriteLine("HackingBench: opening story intro skipped.");
    }
}

[HarmonyPatch(typeof(Programs), nameof(Programs.firstTimeInit))]
public static class IntroPatch
{
    private static int skipNextBoot = Environment.GetEnvironmentVariable("HACKINGBENCH_SKIP_INTRO") == "1" ? 1 : 0;
    [ThreadStatic] private static bool skipDelays;
    [ThreadStatic] private static int skippedSleeps;

    public static void Prefix(out bool __state)
    {
        __state = skipDelays;
        if (Interlocked.Exchange(ref skipNextBoot, 0) == 1)
        {
            skipDelays = true;
            skippedSleeps = 0;
            Console.WriteLine("HackingBench: skipping opening intro animation delays.");
        }
    }

    public static Exception Finalizer(Exception __exception, bool __state)
    {
        if (skipDelays && !__state)
            Console.WriteLine("HackingBench: intro animation skipped (" + skippedSleeps + " presentation sleeps removed).");
        skipDelays = __state;
        return __exception;
    }

    // Only presentation sleeps inside firstTimeInit/typeOut/doDots are routed
    // here. The thread-local scope is restored even when initialization throws.
    public static void Sleep(int milliseconds)
    {
        if (skipDelays) skippedSleeps++;
        else Thread.Sleep(milliseconds);
    }

    public static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
    {
        var sleep = AccessTools.Method(typeof(Thread), nameof(Thread.Sleep), new[] { typeof(int) });
        var replacement = AccessTools.Method(typeof(IntroPatch), nameof(Sleep));
        foreach (var instruction in instructions)
        {
            if (instruction.Calls(sleep))
            {
                instruction.opcode = OpCodes.Call;
                instruction.operand = replacement;
            }
            yield return instruction;
        }
    }
}

[HarmonyPatch]
public static class IntroTextPatch
{
    public static IEnumerable<MethodBase> TargetMethods()
    {
        yield return AccessTools.Method(typeof(Programs), nameof(Programs.typeOut));
        yield return AccessTools.Method(typeof(Programs), nameof(Programs.doDots));
    }

    public static IEnumerable<CodeInstruction> Transpiler(IEnumerable<CodeInstruction> instructions)
        => IntroPatch.Transpiler(instructions);
}
