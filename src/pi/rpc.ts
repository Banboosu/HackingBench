import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonLines } from "../core/jsonl.js";
import { terminate } from "../core/process.js";

interface Pending {
  resolve: (data: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
export class PiRpc extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  private stopping?: Promise<void>;
  start(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): void {
    if (this.child || this.closed)
      throw new Error("Pi process already started or stopped.");
    this.child = spawn(executable, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parser = new JsonLines((record) => {
      if (record.type === "response") {
        const p = this.pending.get(record.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(record.id);
        if (!record.success)
          p.reject(new Error(record.error ?? `RPC ${record.command} failed.`));
        else p.resolve(record.data);
      } else this.emit("record", record);
    });
    this.child.stdout.on("data", (b) => {
      try {
        parser.push(b);
      } catch (e) {
        this.fail(e as Error);
        void this.stop();
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text) => this.emit("diagnostic", text));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("close", (code, signal) => {
      const error = new Error(`Pi exited (code=${code}, signal=${signal}).`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      if (!this.closed) this.emit("fault", error);
    });
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closed) this.emit("fault", error);
  }
  request<T = any>(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<T> {
    if (!this.child || this.closed)
      return Promise.reject(new Error("Pi RPC is not running."));
    const id = `bench-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC timeout: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(
        JSON.stringify({ ...fields, type, id }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Pi RPC stopped."));
    }
    this.pending.clear();
    const child = this.child;
    this.stopping = (async () => {
      if (!child) return;
      child.stdin.end();
      await terminate(child);
    })();
    return this.stopping;
  }
}
