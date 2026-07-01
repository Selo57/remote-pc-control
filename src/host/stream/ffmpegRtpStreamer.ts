import { spawn, type ChildProcess } from "node:child_process";
import dgram, { type Socket } from "node:dgram";
import { EventEmitter } from "node:events";
import { RtpPacket } from "werift";
import type { QualityPreset } from "../../shared/protocol.js";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { chooseEncoder, type EncoderChoice } from "./encoder.js";

export interface StreamStats {
  running: boolean;
  encoder: string;
  fps: number;
  bitrateKbps: number;
  resolution: string;
  droppedFrames: number;
}

export class FfmpegRtpStreamer extends EventEmitter {
  private child?: ChildProcess;
  private udp?: Socket;
  private consumers = 0;
  private backoffMs = 1_000;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private startPromise?: Promise<void>;
  private restartPromise?: Promise<void>;
  private encoder: EncoderChoice = { name: "unknown", label: "unknown", hardware: false, args: [] };
  private failedEncoders = new Set<string>();
  private readonly intentionalStops = new WeakSet<ChildProcess>();
  private startedAt = 0;
  private lastRtpAt = 0;
  private bytesThisSecond = 0;
  private framesThisSecond = 0;
  private stats: StreamStats;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {
    super();
    this.stats = {
      running: false,
      encoder: "unknown",
      fps: 0,
      bitrateKbps: 0,
      resolution: `${config.stream.width}x${config.stream.height}`,
      droppedFrames: 0
    };
    setInterval(() => this.flushStats(), 1_000).unref();
    setInterval(() => this.recoverStalledCapture(), 2_000).unref();
  }

  getStats() {
    return this.stats;
  }

  addConsumer() {
    this.consumers += 1;
    void this.start();
  }

  removeConsumer() {
    this.consumers = Math.max(0, this.consumers - 1);
    if (this.consumers === 0) {
      this.stop();
    }
  }

  async setQuality(preset: QualityPreset) {
    const shouldRestart = this.config.stream.preset !== preset;
    this.config.stream.preset = preset;
    if (shouldRestart) {
      await this.restart();
    }
  }

  async selectMonitor(monitorIndex: number) {
    this.config.stream.monitorIndex = Math.max(0, monitorIndex);
    await this.restart();
  }

  async start() {
    if (this.child || this.consumers === 0) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startCapture();
    try {
      await this.startPromise;
    } catch (error) {
      this.logger.error({ error }, "failed to start ffmpeg capture");
      this.stats.running = false;
      this.closeUdp();
      if (this.consumers > 0) {
        this.scheduleRestart();
      }
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startCapture() {
    this.clearRestartTimer();

    this.encoder = await chooseEncoder(this.config, this.failedEncoders);
    this.stats.encoder = `${this.encoder.label} / ${this.config.stream.captureBackend}`;
    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (message) => this.handleRtp(message));
    this.udp.on("error", (error) => this.logger.error({ error }, "rtp udp socket error"));
    await new Promise<void>((resolve) =>
      this.udp!.bind(this.config.stream.rtpPort, "127.0.0.1", resolve)
    );

    const args = this.ffmpegArgs();
    this.logger.info(
      { args, encoder: this.encoder.label, captureBackend: this.config.stream.captureBackend },
      "starting ffmpeg capture"
    );
    const child = spawn(this.config.stream.ffmpegPath, args, {
      cwd: this.config.rootDir,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const socket = this.udp;
    const encoder = this.encoder;
    const startedAt = Date.now();
    this.child = child;
    this.stats.running = true;
    this.startedAt = startedAt;
    this.lastRtpAt = startedAt;
    this.emit("started", this.stats);

    child.stderr?.on("data", (chunk: Buffer) => this.handleFfmpegLog(chunk));
    child.on("error", (error) => {
      this.logger.error({ error, encoder: encoder.label }, "ffmpeg process error");
    });
    child.on("exit", (code, signal) => {
      const intentional = this.intentionalStops.has(child) || signal === "SIGTERM";
      const runtimeMs = Date.now() - startedAt;
      const logPayload = { code, signal, runtimeMs, encoder: encoder.label };
      if (intentional) {
        this.logger.info(logPayload, "ffmpeg capture stopped");
      } else {
        this.logger.error(logPayload, "ffmpeg capture exited unexpectedly");
      }

      if (
        !intentional &&
        !this.config.stream.forceEncoder &&
        code !== 0 &&
        runtimeMs < 5_000 &&
        encoder.name !== "libx264"
      ) {
        this.failedEncoders.add(encoder.name);
        this.logger.warn({ encoder: encoder.name }, "blacklisting failed encoder for this run");
      }

      if (this.child === child) {
        this.child = undefined;
        this.stats.running = false;
      }
      this.emit("exit", { code, signal });
      if (this.udp === socket) {
        this.closeUdp();
      }
      if (!intentional && this.consumers > 0) {
        this.scheduleRestart();
      }
    });
  }

  stop() {
    this.clearRestartTimer();
    this.stopChild();
    this.closeUdp();
    this.stats.running = false;
    this.emit("stopped");
  }

  async restart() {
    if (this.restartPromise) {
      return this.restartPromise;
    }
    this.restartPromise = this.restartCapture();
    try {
      await this.restartPromise;
    } finally {
      this.restartPromise = undefined;
    }
  }

  private async restartCapture() {
    const hadConsumers = this.consumers;
    this.clearRestartTimer();
    this.stopChild();
    this.closeUdp();
    this.stats.running = false;
    this.consumers = hadConsumers;
    if (hadConsumers > 0) {
      await delay(350);
      await this.start();
    }
  }

  private ffmpegArgs() {
    const bitrate = bitrateFor(
      this.config.stream.preset,
      this.config.stream.width,
      this.config.stream.height
    );
    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      ...this.captureInputArgs(),
      "-vf",
      this.captureFilter(),
      ...this.encoder.args,
      ...profileArgsFor(this.encoder.name),
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(this.config.stream.fps),
      "-keyint_min",
      String(this.config.stream.fps),
      "-b:v",
      `${bitrate}k`,
      "-maxrate",
      `${bitrate}k`,
      "-bufsize",
      `${Math.max(bitrate, 800)}k`,
      "-bsf:v",
      "dump_extra=freq=keyframe",
      "-an",
      "-payload_type",
      "96",
      "-ssrc",
      "2222",
      "-f",
      "rtp",
      `rtp://127.0.0.1:${this.config.stream.rtpPort}?pkt_size=1200`
    ];
  }

  private captureInputArgs() {
    if (this.config.stream.captureBackend === "gdigrab") {
      return [
        "-f",
        "gdigrab",
        "-framerate",
        String(this.config.stream.fps),
        "-draw_mouse",
        "1",
        "-i",
        "desktop"
      ];
    }

    return [
      "-f",
      "lavfi",
      "-i",
      `ddagrab=output_idx=${this.config.stream.monitorIndex}:framerate=${this.config.stream.fps}:draw_mouse=1:dup_frames=1`
    ];
  }

  private captureFilter() {
    const scale = `scale=${this.config.stream.width}:${this.config.stream.height}:force_original_aspect_ratio=decrease,pad=${this.config.stream.width}:${this.config.stream.height}:(ow-iw)/2:(oh-ih)/2`;
    if (this.config.stream.captureBackend === "gdigrab") {
      return `${scale},format=yuv420p`;
    }
    return `hwdownload,format=bgra,${scale},format=yuv420p`;
  }

  private handleRtp(message: Buffer) {
    this.lastRtpAt = Date.now();
    this.bytesThisSecond += message.length;
    try {
      const packet = RtpPacket.deSerialize(message);
      if (packet.header.marker) {
        this.framesThisSecond += 1;
      }
    } catch {
      this.stats.droppedFrames += 1;
      return;
    }
    this.emit("rtp", Buffer.from(message));
    this.backoffMs = 1_000;
  }

  private handleFfmpegLog(chunk: Buffer) {
    const text = chunk.toString("utf8").trim();
    if (text) {
      this.logger.warn({ text }, "ffmpeg");
    }
  }

  private closeUdp() {
    const udp = this.udp;
    this.udp = undefined;
    if (!udp) {
      return;
    }
    try {
      udp.removeAllListeners();
      udp.close();
    } catch (error) {
      this.logger.warn({ error }, "failed to close rtp udp socket");
    }
  }

  private stopChild() {
    const child = this.child;
    this.child = undefined;
    if (!child) {
      return;
    }
    this.intentionalStops.add(child);
    child.kill("SIGTERM");
  }

  private scheduleRestart() {
    if (this.restartTimer) {
      return;
    }
    const waitMs = this.backoffMs;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start();
    }, waitMs);
    this.restartTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
  }

  private clearRestartTimer() {
    if (!this.restartTimer) {
      return;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  private recoverStalledCapture() {
    if (!this.child || this.consumers === 0) {
      return;
    }

    const quietMs = Date.now() - this.lastRtpAt;
    if (quietMs < 5_000 || this.restartPromise) {
      return;
    }

    this.logger.warn(
      { quietMs, encoder: this.encoder.label },
      "stream capture stopped producing RTP; restarting"
    );
    void this.restart();
  }

  private flushStats() {
    this.stats.fps = this.framesThisSecond;
    this.stats.bitrateKbps = Math.round((this.bytesThisSecond * 8) / 1000);
    this.stats.resolution = `${this.config.stream.width}x${this.config.stream.height}`;
    this.bytesThisSecond = 0;
    this.framesThisSecond = 0;
    this.emit("stats", this.stats);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function profileArgsFor(encoderName: string) {
  return encoderName === "h264_amf" ? [] : ["-profile:v", "baseline"];
}

function bitrateFor(preset: QualityPreset, width: number, height: number) {
  const pixels = width * height;
  const base = pixels >= 1920 * 1080 ? 6500 : pixels >= 1280 * 720 ? 4200 : 2400;
  switch (preset) {
    case "low-latency":
      return Math.round(base * 0.7);
    case "high-quality":
      return Math.round(base * 1.5);
    default:
      return base;
  }
}
