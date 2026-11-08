import net from "node:net";
import { EventEmitter } from "node:events";
import { JsonLines } from "../core/jsonl.js";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
/** HNPF-MCP's JSONL named-pipe protocol, with bounded framing and deterministic cleanup. */
export class Bridge extends EventEmitter {
  private socket?: net.Socket;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  constructor(
    readonly pipe: string,
    private token: string,
    private timeoutMs = 8000,
  ) {
    super();
  }
  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }
  async connect(): Promise<void> {
    if (this.socket) throw new Error("Bridge connection already created.");
    const socket = net.createConnection(this.pipe);
    this.socket = socket;
    const parser = new JsonLines((record) => {
      if (record.event) {
        this.emit("event", record);
        return;
      }
      const p = this.pending.get(record.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(record.id);
      if (record.error)
        p.reject(
          new Error(`Bridge ${record.error.code}: ${record.error.message}`),
        );
      else p.resolve(record.result);
    });
    socket.on("data", (b) => {
      try {
        parser.push(b);
      } catch (e) {
        this.close(e as Error);
      }
    });
    socket.on("error", (e) => this.close(e));
    socket.on("close", () => this.close(new Error("Bridge disconnected.")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("Bridge connect timeout."));
      }, this.timeoutMs);
      const failed = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", failed);
        resolve();
      });
    });
    const auth = await this.call("auth", { token: this.token });
    if (auth?.authenticated !== true) {
      this.close();
      throw new Error("Bridge authentication failed.");
    }
  }
  async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.connected) throw new Error("Bridge is not connected.");
    signal?.throwIfAborted();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const fail = (e: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        cleanup();
        reject(e);
      };
      const abort = () =>
        fail(
          new Error(
            "Bridge request aborted; submitted game actions are not rolled back.",
          ),
        );
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Bridge request timed out: ${method}. Do not blindly retry mutations.`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (v) => {
          cleanup();
          resolve(v);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        timer,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.socket!.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (err) => {
          if (err) fail(err);
        },
      );
    });
  }
  close(error = new Error("Bridge closed.")): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}
