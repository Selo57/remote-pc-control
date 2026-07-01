import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import type { AuthService } from "../src/host/auth.js";
import type { AppConfig } from "../src/host/config.js";
import type { InputService } from "../src/host/input/inputService.js";
import type { AppLogger } from "../src/host/logger.js";
import { createAdminServer, createPublicServer, type ServerDeps } from "../src/host/server.js";
import type { StatusModel } from "../src/host/status.js";
import type { LocalStore } from "../src/host/store.js";
import type { FfmpegRtpStreamer } from "../src/host/stream/ffmpegRtpStreamer.js";
import type { WebRtcSessionManager } from "../src/host/webrtc/sessionManager.js";

const servers: Array<ReturnType<typeof createPublicServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

test("public listener never exposes local administration routes", async () => {
  let inputChanges = 0;
  const deps = createDeps({
    input: {
      setEnabled: () => {
        inputChanges += 1;
      }
    } as unknown as InputService
  });
  const baseUrl = await listen(createPublicServer(deps));

  const response = await fetch(`${baseUrl}/api/host/input/enable`, {
    method: "POST",
    headers: {
      "cf-connecting-ip": "203.0.113.40",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https"
    }
  });

  assert.equal(response.status, 404);
  assert.equal(inputChanges, 0);
  assert.equal((await fetch(`${baseUrl}/host`)).status, 404);
});

test("admin listener requires the generated token even for loopback requests", async () => {
  let inputChanges = 0;
  const deps = createDeps({
    input: {
      setEnabled: () => {
        inputChanges += 1;
      }
    } as unknown as InputService
  });
  const baseUrl = await listen(createAdminServer(deps));
  const endpoint = `${baseUrl}/api/host/input/enable`;

  assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { "x-remote-pc-admin-token": "wrong-token" }
      })
    ).status,
    401
  );
  assert.equal(inputChanges, 0);

  const accepted = await fetch(endpoint, {
    method: "POST",
    headers: { "x-remote-pc-admin-token": deps.config.admin.token }
  });
  assert.equal(accepted.status, 200);
  assert.equal(inputChanges, 1);
});

test("admin status cannot be reached by spoofing proxy headers", async () => {
  const deps = createDeps();
  const baseUrl = await listen(createAdminServer(deps));
  const response = await fetch(`${baseUrl}/api/host/status`, {
    headers: {
      "cf-connecting-ip": "127.0.0.1",
      "x-forwarded-for": "127.0.0.1"
    }
  });
  assert.equal(response.status, 401);
});

test("signaling rejects cross-origin WebSocket handshakes", async () => {
  const deps = createDeps({
    auth: {
      requireSession: () => ({
        deviceId: "test-device",
        deviceLabel: "Test",
        permission: "control",
        csrfToken: "test-csrf-token-that-is-long-enough",
        expiresAt: Date.now() + 60_000
      })
    } as unknown as AuthService
  });
  const baseUrl = await listen(createPublicServer(deps));
  const socketUrl = baseUrl.replace("http:", "ws:") + "/ws/signal";

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(socketUrl, {
      headers: { Origin: "https://attacker.example" }
    });
    socket.once("open", () => reject(new Error("Cross-origin socket was accepted.")));
    socket.once("error", () => resolve());
  });
});

test("signaling accepts an authenticated same-origin WebSocket handshake", async () => {
  const deps = createDeps({
    auth: {
      requireSession: () => ({
        deviceId: "test-device",
        deviceLabel: "Test",
        permission: "control",
        csrfToken: "test-csrf-token-that-is-long-enough",
        expiresAt: Date.now() + 60_000
      })
    } as unknown as AuthService
  });
  const baseUrl = await listen(createPublicServer(deps));
  const socketUrl = baseUrl.replace("http:", "ws:") + "/ws/signal";

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(socketUrl, {
      headers: { Origin: baseUrl }
    });
    socket.once("open", () => socket.close());
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
});

function createDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const config: AppConfig = {
    rootDir: path.resolve("."),
    dataDir: path.resolve("data"),
    logDir: path.resolve("logs"),
    secret: "test-secret-that-is-longer-than-thirty-two-characters",
    server: { host: "127.0.0.1", port: 8787, publicBaseUrl: "" },
    admin: {
      host: "127.0.0.1",
      port: 8788,
      token: "test-admin-token-that-is-longer-than-thirty-two-characters"
    },
    security: {
      pin: "12345678",
      requireLocalApproval: true,
      sessionHours: 8
    },
    stream: {
      ffmpegPath: "ffmpeg",
      monitorIndex: 0,
      fps: 60,
      width: 1280,
      height: 720,
      captureBackend: "gdigrab",
      preset: "low-latency",
      forceEncoder: "",
      rtpPort: 5004,
      stunUrls: [],
      turn: []
    },
    cloudflare: {
      enabled: false,
      mode: "quick",
      cloudflaredPath: "cloudflared",
      namedTunnelName: "",
      namedTunnelConfig: "",
      fixedDomain: ""
    },
    discord: { webhookUrl: "" },
    input: { helperPath: "", emergencyHotkey: "CommandOrControl+Alt+Shift+F12" }
  };

  const auth = {
    sessionInfo: () => ({ authenticated: false, pinLogin: true }),
    login: () => {
      throw new Error("Unexpected login call.");
    },
    requireSession: () => {
      throw new Error("Authentication required.");
    },
    requireControl: () => {
      throw new Error("Authentication required.");
    },
    requireCsrf: () => undefined,
    clearCookies: () => undefined
  } as unknown as AuthService;

  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    debug: () => undefined
  } as unknown as AppLogger;

  const status = {
    snapshot: () => ({
      startedAt: new Date(0).toISOString(),
      serverUrl: "http://127.0.0.1:8787",
      remoteAccess: "disabled",
      activeSessions: 0,
      inputEnabled: true,
      stream: {
        running: false,
        encoder: "unknown",
        fps: 0,
        bitrateKbps: 0,
        resolution: "0x0",
        droppedFrames: 0
      },
      health: {}
    })
  } as unknown as StatusModel;

  return {
    config,
    auth,
    store: {
      listTrustedDevices: () => [],
      approveDevice: () => undefined,
      revokeDevice: () => undefined
    } as unknown as LocalStore,
    status,
    input: {
      setEnabled: () => undefined
    } as unknown as InputService,
    streamer: {
      setQuality: async () => undefined,
      restart: async () => undefined
    } as unknown as FfmpegRtpStreamer,
    webrtc: {
      killAll: () => undefined,
      closeAll: async () => undefined,
      handleMessage: async () => undefined,
      close: async () => undefined
    } as unknown as WebRtcSessionManager,
    logger,
    ...overrides
  };
}

async function listen(server: ReturnType<typeof createPublicServer>) {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
