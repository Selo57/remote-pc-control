import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ControlMessage } from "../../shared/protocol.js";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";

export class InputService extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private enabled = true;
  private backoffMs = 1_000;
  private buffer = "";
  private pendingMove?: { dx: number; dy: number };
  private moveTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {
    super();
  }

  start() {
    if (this.child) {
      return;
    }

    const launch = this.resolveLaunch();
    this.logger.info({ command: launch.command, args: launch.args }, "starting input helper");
    const child = spawn(launch.command, launch.args, {
      cwd: this.config.rootDir,
      windowsHide: true,
      stdio: "pipe"
    });

    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) =>
      this.logger.warn({ msg: chunk.toString() }, "input helper stderr")
    );
    child.on("exit", (code, signal) => {
      this.logger.error({ code, signal }, "input helper exited");
      this.child = undefined;
      this.emit("exit");
      setTimeout(() => this.start(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });
  }

  stop() {
    const child = this.child;
    this.child = undefined;
    this.clearPendingMouseMove();
    child?.kill();
  }

  isRunning() {
    return Boolean(this.child && !this.child.killed);
  }

  isEnabled() {
    return this.enabled;
  }

  setEnabled(enabled: boolean) {
    if (!enabled) {
      this.clearPendingMouseMove();
    }
    this.enabled = enabled;
    this.write({ type: "setEnabled", enabled });
    this.emit("enabled", enabled);
  }

  apply(message: ControlMessage) {
    if (!this.enabled && message.type !== "ping") {
      return { accepted: false, reason: "Remote input is disabled on the host." };
    }

    switch (message.type) {
      case "mouseMove":
        this.queueMouseMove(message.dx, message.dy);
        return { accepted: true };
      case "mouseAbs":
      case "mouseButton":
      case "click":
      case "doubleClick":
      case "wheel":
      case "key":
      case "shortcut":
      case "text":
        this.flushPendingMouseMove();
        this.write(message);
        return { accepted: true };
      default:
        return { accepted: false, reason: "Message is not an input command." };
    }
  }

  private resolveLaunch() {
    if (this.config.input.helperPath && existsSync(this.config.input.helperPath)) {
      return { command: this.config.input.helperPath, args: [] as string[] };
    }

    const published = path.join(
      this.config.rootDir,
      "native",
      "RemotePc.InputHost",
      "bin",
      "Release",
      "net8.0-windows",
      "win-x64",
      "publish",
      "RemotePc.InputHost.exe"
    );
    if (existsSync(published)) {
      return { command: published, args: [] as string[] };
    }

    return {
      command: "dotnet",
      args: [
        "run",
        "--project",
        path.join("native", "RemotePc.InputHost", "RemotePc.InputHost.csproj")
      ]
    };
  }

  private write(value: unknown) {
    if (!this.child || !this.child.stdin.writable) {
      this.logger.warn({ value }, "input helper is unavailable");
      return;
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private queueMouseMove(dx: number, dy: number) {
    if (!dx && !dy) {
      return;
    }

    this.pendingMove = {
      dx: (this.pendingMove?.dx ?? 0) + dx,
      dy: (this.pendingMove?.dy ?? 0) + dy
    };

    if (this.moveTimer) {
      return;
    }

    this.moveTimer = setTimeout(() => this.flushPendingMouseMove(), 16);
    this.moveTimer.unref();
  }

  private flushPendingMouseMove() {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = undefined;
    }

    const move = this.pendingMove;
    this.pendingMove = undefined;
    if (!move || (!move.dx && !move.dy)) {
      return;
    }

    this.write({ type: "mouseMove", dx: move.dx, dy: move.dy });
  }

  private clearPendingMouseMove() {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = undefined;
    }
    this.pendingMove = undefined;
  }

  private handleStdout(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as { type?: string; enabled?: boolean };
        if (parsed.type === "ready") {
          this.backoffMs = 1_000;
        }
        if (parsed.type === "enabled" && typeof parsed.enabled === "boolean") {
          this.enabled = parsed.enabled;
        }
        this.emit("message", parsed);
      } catch {
        this.logger.debug({ line }, "input helper stdout");
      }
    }
  }
}
