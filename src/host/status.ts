import type { ComponentHealth, HostStatus } from "../shared/protocol.js";

export class StatusModel {
  readonly startedAt = new Date();
  private readonly health = new Map<string, ComponentHealth>();
  private cloudflareUrl = "";
  private remoteAccess: HostStatus["remoteAccess"] = "disabled";
  private activeSessions = 0;
  private inputEnabled = true;
  private stream = {
    running: false,
    encoder: "unknown",
    fps: 0,
    bitrateKbps: 0,
    resolution: "0x0",
    droppedFrames: 0
  };

  constructor(private readonly serverUrl: string) {}

  setCloudflare(status: HostStatus["remoteAccess"], url = "") {
    this.remoteAccess = status;
    this.cloudflareUrl = url;
  }

  setActiveSessions(count: number) {
    this.activeSessions = count;
  }

  setInputEnabled(enabled: boolean) {
    this.inputEnabled = enabled;
  }

  setStream(stream: Partial<typeof this.stream>) {
    this.stream = { ...this.stream, ...stream };
  }

  markOk(component: string, status = "ok") {
    this.health.set(component, {
      ok: true,
      status,
      lastOkAt: new Date().toISOString(),
      consecutiveFailures: 0
    });
  }

  markFailure(component: string, status: string) {
    const previous = this.health.get(component);
    this.health.set(component, {
      ok: false,
      status,
      lastOkAt: previous?.lastOkAt,
      lastErrorAt: new Date().toISOString(),
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
    });
  }

  snapshot(): HostStatus {
    return {
      startedAt: this.startedAt.toISOString(),
      serverUrl: this.serverUrl,
      remoteAccess: this.remoteAccess,
      cloudflareUrl: this.cloudflareUrl || undefined,
      activeSessions: this.activeSessions,
      inputEnabled: this.inputEnabled,
      stream: this.stream,
      health: Object.fromEntries(this.health)
    };
  }
}
