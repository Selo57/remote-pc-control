import type { Server } from "node:http";
import type { CloudflaredSupervisor } from "./cloudflare/cloudflaredSupervisor.js";
import type { DiscordNotifier } from "./discord.js";
import type { InputService } from "./input/inputService.js";
import type { AppLogger } from "./logger.js";
import type { StatusModel } from "./status.js";
import type { FfmpegRtpStreamer } from "./stream/ffmpegRtpStreamer.js";

interface WatchdogDeps {
  server: Server;
  cloudflare: CloudflaredSupervisor;
  input: InputService;
  streamer: FfmpegRtpStreamer;
  status: StatusModel;
  discord: DiscordNotifier;
  logger: AppLogger;
}

export class Watchdog {
  private timer?: NodeJS.Timeout;
  private unrecoverableNotified = false;

  constructor(private readonly deps: WatchdogDeps) {}

  start() {
    this.timer = setInterval(() => void this.check(), 5_000);
    this.timer.unref();
    void this.check();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async check() {
    const { status, input, streamer, cloudflare, logger, discord } = this.deps;

    if (this.deps.server.listening) {
      status.markOk("local-server", "listening");
    } else {
      status.markFailure("local-server", "not listening");
    }

    if (input.isRunning()) {
      status.markOk("input-service", input.isEnabled() ? "enabled" : "disabled");
    } else {
      status.markFailure("input-service", "not running");
      input.start();
    }

    const streamStats = streamer.getStats();
    status.setStream(streamStats);
    if (streamStats.running || this.noActiveStreamNeeded()) {
      status.markOk("stream-capture", streamStats.running ? streamStats.encoder : "idle");
    } else {
      status.markFailure("stream-capture", "not running");
    }

    if (!cloudflare.isEnabled()) {
      status.markOk("cloudflare-tunnel", "disabled");
    } else if (cloudflare.url()) {
      status.markOk("cloudflare-tunnel", cloudflare.url());
    } else if (cloudflare.isRunning()) {
      status.markOk("cloudflare-tunnel", "connecting");
    } else {
      status.markFailure("cloudflare-tunnel", "not running");
      cloudflare.start();
    }

    const snapshot = status.snapshot();
    const failed = Object.values(snapshot.health).filter(
      (item) => !item.ok && item.consecutiveFailures >= 6
    );
    if (failed.length > 0) {
      logger.warn({ failed }, "watchdog repeated failures");
    }
    if (failed.length >= 3 && !this.unrecoverableNotified) {
      this.unrecoverableNotified = true;
      await discord.send("Remote PC needs attention.");
    }
    if (failed.length === 0) {
      this.unrecoverableNotified = false;
    }
  }

  private noActiveStreamNeeded() {
    return this.deps.status.snapshot().activeSessions === 0;
  }
}
