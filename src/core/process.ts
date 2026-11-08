import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function command(
  exe: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminate(child);
    }, options.timeout ?? 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => {
      out = (out + s).slice(-512000);
    });
    child.stderr.on("data", (s) => {
      err = (err + s).slice(-64000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${exe} timed out.`));
      else if (code !== 0)
        reject(new Error(`${exe} exited ${code}: ${err || out}`));
      else resolve(out);
    });
  });
}
export async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, "close").catch(() => undefined);
  if (process.platform === "win32") {
    // Do not use command() here: its timeout also calls terminate(), which could recurse.
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
      const timer = setTimeout(() => {
        killer.kill();
        child.kill();
        resolve();
      }, 10000);
      killer.on("error", () => {
        clearTimeout(timer);
        child.kill();
        resolve();
      });
      killer.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) child.kill();
        resolve();
      });
    });
  } else child.kill("SIGTERM");
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
