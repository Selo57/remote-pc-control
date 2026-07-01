import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AppConfig } from "../config.js";
import type { DiscordNotifier } from "../discord.js";
import type { AppLogger } from "../logger.js";

export class CloudflaredSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private backoffMs = 1_000;
  private currentUrl = "";
  private stopped = false;
  private hadTunnelFailure = false;
  private reportedFixedDomain = "";

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly discord: DiscordNotifier
  ) {
    super();
  }

  start() {
    if (!this.config.cloudflare.enabled) {
      this.emit("status", { status: "disabled", url: "" });
      return;
    }
    if (this.child) {
      return;
    }
    this.stopped = false;
    this.launch();
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = undefined;
  }

  isRunning() {
    return Boolean(this.child && !this.child.killed);
  }

  isEnabled() {
    return this.config.cloudflare.enabled;
  }

  url() {
    return this.config.cloudflare.fixedDomain || this.currentUrl;
  }

  private launch() {
    const args = this.args();
    this.logger.info({ args }, "starting cloudflared");
    const child = spawn(this.config.cloudflare.cloudflaredPath, args, {
      cwd: this.config.rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.emit("status", { status: "connecting", url: this.url() });

    child.stdout.on("data", (chunk: Buffer) => this.handleOutput(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleOutput(chunk));
    child.on("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "cloudflared exited");
      this.child = undefined;
      this.emit("status", { status: "error", url: this.url() });
      if (!this.stopped) {
        this.hadTunnelFailure = true;
        setTimeout(() => this.launch(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
      }
    });
  }

  private args() {
    if (this.config.cloudflare.mode === "named") {
      const args = ["tunnel"];
      if (this.config.cloudflare.namedTunnelConfig) {
        args.push("--config", this.config.cloudflare.namedTunnelConfig);
      }
      args.push("run");
      if (this.config.cloudflare.namedTunnelName) {
        args.push(this.config.cloudflare.namedTunnelName);
      }
      return args;
    }

    return ["tunnel", "--url", `http://127.0.0.1:${this.config.server.port}`];
  }

  private handleOutput(chunk: Buffer) {
    const text = chunk.toString("utf8");
    const trimmed = text.trim();
    if (trimmed) {
      this.logger.info({ text: trimmed }, "cloudflared");
    }

    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && match[0] !== this.currentUrl) {
      const previous = this.currentUrl;
      this.currentUrl = match[0];
      this.backoffMs = 1_000;
      this.emit("url", this.currentUrl);
      this.emit("status", { status: "online", url: this.currentUrl });
      if (!previous) {
        void this.discord.send(`Remote PC started a new link report: ${this.currentUrl}`);
      } else if (this.hadTunnelFailure) {
        void this.discord.send(`Remote PC reconnected with new link: ${this.currentUrl}`);
      } else {
        void this.discord.send(`Remote PC link changed: ${this.currentUrl}`);
      }
      this.hadTunnelFailure = false;
    }

    if (
      this.config.cloudflare.fixedDomain &&
      this.reportedFixedDomain !== this.config.cloudflare.fixedDomain &&
      /registered|connected|route|ingress|ready/i.test(text)
    ) {
      this.reportedFixedDomain = this.config.cloudflare.fixedDomain;
      this.emit("status", { status: "online", url: this.config.cloudflare.fixedDomain });
      void this.discord.send(
        `Remote PC started a new link report: ${this.config.cloudflare.fixedDomain}`
      );
    }
  }
}
