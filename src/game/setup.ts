import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  lstat,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import {
  ROOT,
  RUNTIME,
  gameWindow,
  writeJson,
  type BenchConfig,
} from "../config.js";
import { exists, inspect } from "../environment.js";
import { assertNoLinks, childEnvironment, within } from "../core/safety.js";
import { command } from "../core/process.js";
import { binaryFingerprints, verifyBinaries } from "./integrity.js";
import { ensureGameWindow } from "./display.js";

const ASSETS = {
  pathfinder: {
    name: "Pathfinder-5.3.4.zip",
    url: "https://github.com/Arkhist/Hacknet-Pathfinder/releases/download/v5.3.4/Pathfinder.Release.zip",
    sha: "245b3ff727ccb1a97c3857106310316e84e973bb9d9b154f3e834a5ca05aaf71",
    max: 5_000_000,
  },
  compiler: {
    name: "roslyn-4.8.0.zip",
    url: "https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/4.8.0/microsoft.net.compilers.toolset.4.8.0.nupkg",
    sha: "37333f4f1e2ce55e621355d6da651dc23d4cb5f94a8f76b9478816e87f110ad9",
    max: 40_000_000,
  },
};
export function zipDestination(root: string, name: string): string {
  if (
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("/") ||
    name.split("/").includes("..")
  )
    throw new Error("Unsafe archive path.");
  const dest = path.resolve(root, name);
  if (!within(root, dest)) throw new Error("Archive path escapes destination.");
  return dest;
}
async function asset(
  spec: typeof ASSETS.pathfinder,
  log: (s: string) => void,
): Promise<Uint8Array> {
  const file = path.join(RUNTIME, "downloads", spec.name);
  await assertNoLinks(RUNTIME, file);
  let bytes: Buffer;
  if (await exists(file)) bytes = await readFile(file);
  else {
    log(`Downloading ${spec.name} (pinned, SHA-256 verified)…`);
    const response = await fetch(spec.url, {
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
      throw new Error(`Download failed: HTTP ${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.length;
      if (size > spec.max)
        throw new Error("Download exceeds expected size limit.");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== spec.sha)
    throw new Error(
      `Checksum mismatch: ${spec.name}. Remove the cached file and retry.`,
    );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}
async function extract(bytes: Uint8Array, root: string): Promise<void> {
  const entries = unzipSync(bytes);
  let total = 0;
  for (const [name, data] of Object.entries(entries)) {
    total += data.length;
    if (total > 250_000_000)
      throw new Error("Archive expanded size exceeds limit.");
    const dest = zipDestination(root, name);
    await assertNoLinks(RUNTIME, dest);
    if (name.endsWith("/")) await mkdir(dest, { recursive: true });
    else {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
  }
}
async function regularCopy(source: string, dest: string): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    filter: async (src) => {
      if ((await lstat(src)).isSymbolicLink())
        throw new Error(`Refusing game source link: ${src}`);
      // Never import existing save accounts, plugins, Steam identifiers, or debug logs.
      return ![
        "BepInEx",
        "Accounts",
        "Reports",
        "steam_appid.txt",
        "debug.log",
        "crashLog.txt",
      ].includes(path.basename(src));
    },
  });
}
export async function adapterFingerprint(): Promise<string> {
  const hash = createHash("sha256");
  for (const dir of [
    path.join(ROOT, "bridge"),
    path.join(ROOT, "vendor", "hnpf-mcp", "bridge"),
  ]) {
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".cs"))
      .sort()) {
      hash.update(name);
      hash.update(
        (await readFile(path.join(dir, name), "utf8")).replace(/\r\n/g, "\n"),
      );
    }
  }
  return hash.digest("hex");
}
export async function buildBridge(
  gameRoot: string,
  log: (s: string) => void,
): Promise<void> {
  await assertNoLinks(RUNTIME, gameRoot);
  const compiler = path.join(RUNTIME, "tools", "roslyn-4.8.0");
  if (!(await exists(path.join(compiler, "tasks", "net472", "csc.exe"))))
    await extract(await asset(ASSETS.compiler, log), compiler);
  log("Compiling HNPF-MCP + original-campaign player adapter…");
  const upstream = path.join(ROOT, "vendor", "hnpf-mcp", "bridge");
  const sources = (await readdir(upstream))
    .filter((f) => f.endsWith(".cs") && f !== "MenuExecutor.cs")
    .map((f) => path.join(upstream, f));
  const own = path.join(ROOT, "bridge");
  sources.push(
    ...(await readdir(own))
      .filter((f) => f.endsWith(".cs"))
      .map((f) => path.join(own, f)),
  );
  const core = path.join(gameRoot, "BepInEx", "core");
  const refs = [
    "0Harmony.dll",
    "BepInEx.Core.dll",
    "BepInEx.Hacknet.dll",
    "Mono.Cecil.dll",
  ].map((f) => path.join(core, f));
  refs.push(
    path.join(gameRoot, "BepInEx", "plugins", "PathfinderAPI.dll"),
    path.join(gameRoot, "Hacknet.exe"),
    path.join(gameRoot, "FNA.dll"),
  );
  const dll = path.join(gameRoot, "BepInEx", "plugins", "HnpfMcpBridge.dll");
  const args = [
    "/nologo",
    "/utf8output",
    "/target:library",
    "/platform:x86",
    "/langversion:11",
    "/unsafe",
    "/nowarn:8500",
    "/out:" + dll,
    "/r:System.Web.Extensions.dll",
    ...refs.map((f) => "/r:" + f),
    ...sources,
  ];
  const rsp = path.join(RUNTIME, "build.rsp");
  await writeFile(rsp, args.map((a) => '"' + a + '"').join("\n"));
  await command(
    path.join(compiler, "tasks", "net472", "csc.exe"),
    ["@" + rsp],
    { cwd: gameRoot, env: childEnvironment(), timeout: 120000 },
  );
}
export async function prepareGame(
  config: BenchConfig,
  log: (s: string) => void,
): Promise<void> {
  const environment = await inspect(config);
  if (environment.problems.length)
    throw new Error(environment.problems.join("\n"));
  await mkdir(RUNTIME, { recursive: true });
  await assertNoLinks(RUNTIME, RUNTIME);
  const lock = path.join(RUNTIME, "setup.lock");
  await assertNoLinks(RUNTIME, lock);
  const handle = await import("node:fs/promises").then((fs) =>
    fs.open(lock, "wx"),
  );
  try {
    const game = path.join(RUNTIME, "game");
    const stage = path.join(RUNTIME, "game.staging");
    await assertNoLinks(RUNTIME, game);
    await assertNoLinks(RUNTIME, stage);
    if (await exists(path.join(RUNTIME, "active-run.lock")))
      throw new Error("A run is active. Stop it before setup.");
    if (await exists(game)) {
      if (await exists(path.join(game, ".hackingbench-install.json"))) {
        const file = path.join(game, ".hackingbench-install.json");
        const marker = JSON.parse(await readFile(file, "utf8"));
        if (marker.offlinePatchVersion !== 2 || marker.version !== 2)
          throw new Error(
            "The prepared game uses an older isolation contract. Move runtime/game aside and run setup again.",
          );
        await verifyBinaries(game, marker.binaryFingerprints);
        const sourceHash = await adapterFingerprint();
        if (marker.adapterFingerprint !== sourceHash || !marker.gameSha256) {
          await buildBridge(game, log);
          marker.adapterFingerprint = sourceHash;
          marker.bridgeSha256 = createHash("sha256")
            .update(
              await readFile(
                path.join(game, "BepInEx", "plugins", "HnpfMcpBridge.dll"),
              ),
            )
            .digest("hex");
          marker.gameSha256 = createHash("sha256")
            .update(await readFile(path.join(game, "Hacknet.exe")))
            .digest("hex");
          marker.binaryFingerprints = await binaryFingerprints(game);
          await writeJson(file, marker);
        }
        await ensureGameWindow(game, gameWindow(config));
        log(
          "Existing project game copy is ready with the configured game window.",
        );
        return;
      }
      throw new Error(
        "runtime/game already exists without an install marker. Move it aside manually; it will not be overwritten.",
      );
    }
    if (await exists(stage))
      throw new Error(
        "An interrupted setup left runtime/game.staging. Inspect/remove it, then retry.",
      );
    const source = environment.gameSource!;
    if (within(RUNTIME, source) || within(source, ROOT))
      throw new Error(
        "Game source must be outside the project, and must not contain the project.",
      );
    log(
      "Copying Steam installation into runtime/game.staging (source remains untouched)…",
    );
    const free = await import("node:fs/promises").then((fs) =>
      fs.statfs(RUNTIME),
    );
    if (free.bavail * free.bsize < 1_500_000_000)
      throw new Error("Setup requires at least 1.5 GB free space.");
    await regularCopy(source, stage);
    log("Installing Pathfinder 5.3.4 + bundled BepInEx into the copy…");
    await extract(await asset(ASSETS.pathfinder, log), stage);
    await command(path.join(stage, "PathfinderPatcher.exe"), [], {
      cwd: stage,
      env: childEnvironment(),
      timeout: 120000,
    });
    if (!(await exists(path.join(stage, "HacknetPathfinder.exe"))))
      throw new Error("Pathfinder patcher did not produce a game executable.");
    await rename(
      path.join(stage, "Hacknet.exe"),
      path.join(stage, "HacknetOriginal.exe"),
    );
    await rename(
      path.join(stage, "HacknetPathfinder.exe"),
      path.join(stage, "Hacknet.exe"),
    );
    // Updaters must never mutate pinned dependencies during a run.
    await rm(path.join(stage, "BepInEx", "plugins", "PathfinderUpdater.dll"), {
      force: true,
    });
    log(
      "Applying offline save isolation and disabling Steam/cloud in the project copy…",
    );
    await command(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(ROOT, "scripts", "patch-game.ps1"),
        "-GameDirectory",
        stage,
      ],
      { cwd: ROOT, env: childEnvironment() },
    );
    await ensureGameWindow(stage, gameWindow(config));
    await buildBridge(stage, log);
    const dll = path.join(stage, "BepInEx", "plugins", "HnpfMcpBridge.dll");
    await writeJson(path.join(stage, ".hackingbench-install.json"), {
      version: 2,
      source,
      installedAt: new Date().toISOString(),
      pathfinder: "5.3.4",
      hnpfCommit: "46b13a132f84939ab26f2e2137001824d76e8f61",
      steamDisabled: true,
      saveRoot: "HACKINGBENCH_SAVE_DIR",
      offlinePatchVersion: 2,
      adapterFingerprint: await adapterFingerprint(),
      binaryFingerprints: await binaryFingerprints(stage),
      gameSha256: createHash("sha256")
        .update(await readFile(path.join(stage, "Hacknet.exe")))
        .digest("hex"),
      bridgeSha256: createHash("sha256")
        .update(await readFile(dll))
        .digest("hex"),
    });
    await rename(stage, game);
    log("Game copy prepared. No game has been launched yet.");
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}
