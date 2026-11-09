import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Bridge } from "../src/game/bridge.js";
import { Player, boundedText } from "../src/game/player.js";
import { PLAYER_TOOLS } from "../src/core/safety.js";

export default function hacknetPlayer(pi: ExtensionAPI) {
  const screenshots = process.env.HACKINGBENCH_IMAGES === "1";
  const names: string[] = [
    ...PLAYER_TOOLS,
    ...(screenshots ? ["hn_screenshot"] : []),
  ];
  let bridge: Bridge | undefined;
  let player: Player | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const use = async <T>(f: (p: Player) => Promise<T>): Promise<T> => {
    // Serialize even if a provider issues several calls in one assistant message.
    const result = queue.then(async () => {
      if (!player) {
        const pipe = process.env.HACKINGBENCH_PIPE;
        const token = process.env.HACKINGBENCH_PIPE_TOKEN;
        if (!pipe || !token)
          throw new Error("Benchmark bridge configuration is missing.");
        bridge = new Bridge(pipe, token);
        try {
          await bridge.connect();
        } catch (e) {
          bridge.close();
          bridge = undefined;
          throw e;
        }
        player = new Player(bridge);
      }
      return f(player);
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: boundedText(value) }],
    details: {},
  });
  const guard = () => {
    pi.setActiveTools(names);
    const active = pi.getActiveTools();
    if (
      active.length !== names.length ||
      active.some((n) => !names.includes(n))
    )
      throw new Error("Player tool loadout assertion failed.");
    return active;
  };
  pi.on("session_start", () => {
    guard();
  });
  pi.on("before_agent_start", () => {
    guard();
  });
  pi.on("tool_call", (event) => {
    if (!names.includes(event.toolName))
      return {
        block: true,
        reason: "Only benchmark player tools are permitted.",
        terminate: true,
      };
  });
  pi.on("user_bash", () => ({
    result: {
      output: "Shell execution is disabled in benchmark sessions.",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  }));
  pi.on("session_shutdown", () => {
    bridge?.close();
    bridge = undefined;
    player = undefined;
  });
  pi.registerCommand("bench-status", {
    description: "Runner-only tool-loadout handshake",
    handler: async () => {
      pi.appendEntry("bench.ready", { activeTools: guard(), protocol: 1 });
    },
  });
  pi.registerTool({
    name: "hn_cmd",
    label: "Terminal",
    executionMode: "sequential",
    description:
      "Run ONE Hacknet virtual-terminal command. All in-game exes are available; debug/cheat commands are blocked. No host shell syntax or host paths. Returns changed terminal rows, limited to 4 KiB. Briefly polls row contents until stable, including in-place writes and rolling history; normal commands do not need an extra wait. If nothing changed, output=snapshot labels current terminal context plus fresh game state, not new command output. Long-running executables still use hn_wait.",
    parameters: Type.Object({
      cmd: Type.String({ minLength: 1, maxLength: 256 }),
    }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.cmd(args.cmd, signal)));
    },
  });
  pi.registerTool({
    name: "hn_shell",
    label: "Shell overload",
    executionMode: "sequential",
    description:
      "Drive a Hacknet shell already opened on a compromised node. First run `shell` on a node where you have admin access, repeat on other owned nodes as needed, connect to the proxy target, then use overload; actions apply to ALL active shells: cancel stops overloading, exit closes them. hn_screen shows shell count/IPs, each shell's state (0 idle, 1 overloading), targetIP and proxy overloadTicks. Overload is asynchronous: use hn_wait and check that proxyActive becomes false.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("overload"),
        Type.Literal("cancel"),
        Type.Literal("exit"),
      ]),
    }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.shell(args.action, signal)));
    },
  });
  pi.registerTool({
    name: "hn_screen",
    label: "Screen",
    executionMode: "sequential",
    description:
      "Observe the game terminal, visible network nodes, RAM and running programs. No hidden credentials or flags. Limited to 4 KiB.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      return result(await use((p) => p.screen(signal)));
    },
  });
  pi.registerTool({
    name: "hn_wait",
    label: "Wait",
    executionMode: "sequential",
    description:
      "Wait 0.1–30 real seconds for programs or story events; then observe the game.",
    parameters: Type.Object({
      seconds: Type.Number({ minimum: 0.1, maximum: 30 }),
    }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.wait(args.seconds, signal)));
    },
  });
  pi.registerTool({
    name: "hn_input",
    label: "Prompt input",
    executionMode: "sequential",
    description:
      "Submit a username, password, or answer ONLY when the game terminal is awaiting interactive input (see hn_screen.awaitingInput). Never executes input as a command.",
    parameters: Type.Object({ text: Type.String({ maxLength: 256 }) }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.input(args.text, signal)));
    },
  });
  pi.registerTool({
    name: "hn_tutorial",
    label: "Tutorial button",
    executionMode: "sequential",
    description:
      "Press the currently visible tutorial Continue or Hint button. Check hn_screen.tutorial first. This cannot skip command-driven tutorial steps.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("continue"), Type.Literal("hint")]),
    }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.tutorial(args.action, signal)));
    },
  });
  pi.registerTool({
    name: "hn_mail",
    label: "Mail",
    executionMode: "sequential",
    description:
      "List/read ONLY your own game inbox. List returns mail IDs; read requires an ID. Limited to 4 KiB.",
    parameters: Type.Object({
      action: Type.String({ enum: ["list", "read"] }),
      id: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    async execute(_id, args, signal) {
      return result(
        await use((p) =>
          p.mail(args.action as "list" | "read", args.id, signal),
        ),
      );
    },
  });
  pi.registerTool({
    name: "hn_reply",
    label: "Reply",
    executionMode: "sequential",
    description:
      "Reply to a game email to submit your completed work. The game validates objectives and sender; this does not bypass tasks. Use the mail ID and requested answer (or complete).",
    parameters: Type.Object({
      id: Type.Integer({ minimum: 0 }),
      answer: Type.String({ maxLength: 2000 }),
    }),
    async execute(_id, args, signal) {
      return result(await use((p) => p.reply(args.id, args.answer, signal)));
    },
  });
  pi.registerTool({
    name: "hn_hub",
    label: "Mission hub",
    executionMode: "sequential",
    description:
      "List/read/accept postings on the board you are currently connected to. Use only IDs returned by list; refresh after accepting. Private boards require normal login. listing: boards return kind=contract or article and canAccept; read shows only the visible posting text (including public education/news articles). Articles cannot be accepted. Accept a contract, then read the new email for task instructions. Read is currently supported only for listing: IDs.",
    parameters: Type.Object({
      action: Type.String({ enum: ["list", "read", "accept"] }),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, args, signal) {
      return result(
        await use((p) =>
          p.hub(args.action as "list" | "read" | "accept", args.id, signal),
        ),
      );
    },
  });
  pi.registerTool({
    name: "hn_give_up",
    label: "Give up",
    executionMode: "sequential",
    description:
      "End this attempt if you cannot progress. Do not claim success; completion is checked independently.",
    parameters: Type.Object({ reason: Type.String({ maxLength: 1000 }) }),
    async execute(_id, args) {
      return {
        ...result(args.reason),
        details: { benchStatus: "gave_up" },
        terminate: true,
      };
    },
  });
  if (screenshots)
    pi.registerTool({
      name: "hn_screenshot",
      label: "Game screenshot",
      executionMode: "sequential",
      description:
        "Capture ONLY the Hacknet framebuffer, not the desktop. Use with a vision-capable model.",
      parameters: Type.Object({}),
      async execute(_id, _args, signal) {
        const image = await use((p) => p.capture(signal));
        return {
          content: [
            {
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            },
          ],
          details: {},
        };
      },
    });
}
