import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Bridge } from '../src/game/bridge.js';
import { Player, boundedText } from '../src/game/player.js';
import { PLAYER_TOOLS } from '../src/core/safety.js';

export default function hacknetPlayer(pi: ExtensionAPI) {
  const screenshots = process.env.HACKINGBENCH_IMAGES === '1';
  const names: string[] = [...PLAYER_TOOLS, ...(screenshots ? ['hn_screenshot'] : [])];
  let bridge: Bridge | undefined;
  let player: Player | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let steps = 0;
  const maxSteps = Number(process.env.HACKINGBENCH_MAX_STEPS ?? '1500');
  const deadline = Number(process.env.HACKINGBENCH_DEADLINE ?? '0');
  const use = async <T>(f: (p: Player) => Promise<T>): Promise<T> => {
    // Serialize even if a provider issues several calls in one assistant message.
    const result = queue.then(async () => {
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        pi.appendEntry('bench.limit', {status:'timeout'});
        throw new Error('Player wall-clock deadline exceeded.');
      }
      if (!player) {
        const pipe = process.env.HACKINGBENCH_PIPE;
        const token = process.env.HACKINGBENCH_PIPE_TOKEN;
        if (!pipe || !token) throw new Error('Benchmark bridge configuration is missing.');
        bridge = new Bridge(pipe, token);
        try { await bridge.connect(); } catch (e) { bridge.close(); bridge = undefined; throw e; }
        player = new Player(bridge);
      }
      return f(player);
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: boundedText(value) }], details: {} });
  const guard = () => {
    pi.setActiveTools(names);
    const active = pi.getActiveTools();
    if (active.length !== names.length || active.some(n => !names.includes(n))) throw new Error('Player tool loadout assertion failed.');
    return active;
  };
  pi.on('session_start', () => { guard(); });
  pi.on('before_agent_start', () => { guard(); });
  pi.on('tool_call', (event) => {
    if (!names.includes(event.toolName)) return { block: true, reason: 'Only benchmark player tools are permitted.', terminate: true };
    if (!Number.isFinite(deadline) || deadline <= Date.now()) {
      pi.appendEntry('bench.limit', {status:'timeout'});
      return { block: true, reason: 'Player wall-clock deadline exceeded.', terminate: true };
    }
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || steps >= maxSteps) {
      pi.appendEntry('bench.limit', {status:'budget_exhausted'});
      return { block: true, reason: 'Player tool budget exhausted.', terminate: true };
    }
    steps++;
  });
  pi.on('user_bash', () => ({ result: { output: 'Shell execution is disabled in benchmark sessions.', exitCode: 1, cancelled: false, truncated: false } }));
  pi.on('session_shutdown', () => { bridge?.close(); bridge = undefined; player = undefined; });
  pi.registerCommand('bench-status', {
    description: 'Runner-only tool-loadout handshake',
    handler: async () => { pi.appendEntry('bench.ready', { activeTools: guard(), protocol: 1 }); },
  });
  pi.registerTool({
    name: 'hn_cmd', label: 'Terminal', executionMode: 'sequential',
    description: 'Run ONE allowed Hacknet virtual-terminal command. No shell syntax or host paths. Returns new output, limited to 4 KiB. Executables finish asynchronously; use hn_wait.',
    parameters: Type.Object({ cmd: Type.String({ minLength: 1, maxLength: 256 }) }),
    async execute(_id, args, signal) { return result(await use(p => p.cmd(args.cmd, signal))); },
  });
  pi.registerTool({
    name: 'hn_screen', label: 'Screen', executionMode: 'sequential',
    description: 'Observe the game terminal, visible network nodes, RAM and running programs. No hidden credentials or flags. Limited to 4 KiB.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) { return result(await use(p => p.screen(signal))); },
  });
  pi.registerTool({
    name: 'hn_wait', label: 'Wait', executionMode: 'sequential',
    description: 'Wait 0.1–30 real seconds for programs or story events; then observe the game. Counts against the wall-clock budget.',
    parameters: Type.Object({ seconds: Type.Number({ minimum: 0.1, maximum: 30 }) }),
    async execute(_id, args, signal) { return result(await use(p => p.wait(args.seconds, signal))); },
  });
  pi.registerTool({
    name: 'hn_input', label: 'Prompt input', executionMode: 'sequential',
    description: 'Submit a username, password, or answer ONLY when the game terminal is awaiting interactive input (see hn_screen.awaitingInput). Never executes input as a command.',
    parameters: Type.Object({ text: Type.String({ maxLength: 256 }) }),
    async execute(_id, args, signal) { return result(await use(p => p.input(args.text, signal))); },
  });
  pi.registerTool({
    name: 'hn_tutorial', label: 'Tutorial button', executionMode: 'sequential',
    description: 'Press the currently visible tutorial Continue or Hint button. Check hn_screen.tutorial first. This cannot skip command-driven tutorial steps.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('continue'),Type.Literal('hint')]) }),
    async execute(_id, args, signal) { return result(await use(p => p.tutorial(args.action, signal))); },
  });
  pi.registerTool({
    name: 'hn_mail', label: 'Mail', executionMode: 'sequential',
    description: 'List/read ONLY your own game inbox. List returns mail IDs; read requires an ID. Limited to 4 KiB.',
    parameters: Type.Object({ action: Type.String({ enum: ['list','read'] }), id: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, args, signal) { return result(await use(p => p.mail(args.action as 'list' | 'read', args.id, signal))); },
  });
  pi.registerTool({
    name: 'hn_reply', label: 'Reply', executionMode: 'sequential',
    description: 'Reply to a game email to submit your completed work. The game validates objectives and sender; this does not bypass tasks. Use the mail ID and requested answer (or complete).',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), answer: Type.String({ maxLength: 2000 }) }),
    async execute(_id, args, signal) { return result(await use(p => p.reply(args.id, args.answer, signal))); },
  });
  pi.registerTool({
    name: 'hn_hub', label: 'Mission hub', executionMode: 'sequential',
    description: 'List or accept visible contracts on the mission hub you are currently connected to. Use only IDs returned by list.',
    parameters: Type.Object({ action: Type.String({ enum: ['list','accept'] }), id: Type.Optional(Type.String()) }),
    async execute(_id, args, signal) { return result(await use(p => p.hub(args.action as 'list' | 'accept', args.id, signal))); },
  });
  pi.registerTool({
    name: 'hn_give_up', label: 'Give up', executionMode: 'sequential',
    description: 'End this attempt if you cannot progress. Do not claim success; completion is checked independently.',
    parameters: Type.Object({ reason: Type.String({ maxLength: 1000 }) }),
    async execute(_id, args) { return { ...result(args.reason), details: { benchStatus: 'gave_up' }, terminate: true }; },
  });
  if (screenshots) pi.registerTool({
    name: 'hn_screenshot', label: 'Game screenshot', executionMode: 'sequential',
    description: 'Capture ONLY the Hacknet framebuffer, not the desktop. Use with a vision-capable model.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const image = await use(p => p.capture(signal));
      return { content: [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }], details: {} };
    },
  });
}
