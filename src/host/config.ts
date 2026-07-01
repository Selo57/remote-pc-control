import dotenv from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const qualityPreset = z.enum(["low-latency", "balanced", "high-quality"]);
const captureBackend = z.enum(["ddagrab", "gdigrab"]);

const configFileSchema = z
  .object({
    server: z
      .object({
        host: z.string().optional(),
        port: z.number().optional(),
        publicBaseUrl: z.string().optional()
      })
      .optional(),
    security: z
      .object({
        requireLocalApproval: z.boolean().optional(),
        sessionHours: z.number().optional()
      })
      .optional(),
    stream: z
      .object({
        monitorIndex: z.number().optional(),
        fps: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        captureBackend: captureBackend.optional(),
        preset: qualityPreset.optional(),
        forceEncoder: z.string().optional(),
        rtpPort: z.number().optional(),
        stunUrls: z.array(z.string()).optional(),
        turn: z
          .array(
            z.object({
              urls: z.string(),
              username: z.string().optional(),
              credential: z.string().optional()
            })
          )
          .optional()
      })
      .optional(),
    cloudflare: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["quick", "named"]).optional(),
        cloudflaredPath: z.string().optional(),
        namedTunnelName: z.string().optional(),
        namedTunnelConfig: z.string().optional(),
        fixedDomain: z.string().optional()
      })
      .optional()
  })
  .default({});

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  logDir: string;
  secret: string;
  server: {
    host: string;
    port: number;
    publicBaseUrl: string;
  };
  admin: {
    host: "127.0.0.1";
    port: number;
    token: string;
  };
  security: {
    pin: string;
    requireLocalApproval: boolean;
    sessionHours: number;
  };
  stream: {
    ffmpegPath: string;
    monitorIndex: number;
    fps: number;
    width: number;
    height: number;
    captureBackend: "ddagrab" | "gdigrab";
    preset: "low-latency" | "balanced" | "high-quality";
    forceEncoder: string;
    rtpPort: number;
    stunUrls: string[];
    turn: Array<{ urls: string; username?: string; credential?: string }>;
  };
  cloudflare: {
    enabled: boolean;
    mode: "quick" | "named";
    cloudflaredPath: string;
    namedTunnelName: string;
    namedTunnelConfig: string;
    fixedDomain: string;
  };
  discord: {
    webhookUrl: string;
  };
  input: {
    helperPath: string;
    emergencyHotkey: string;
  };
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  const configPath = process.env.REMOTE_PC_CONFIG ?? path.join(rootDir, "config.json");
  const fileConfig = existsSync(configPath)
    ? configFileSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    : {};

  const dataDir = path.resolve(rootDir, env("REMOTE_PC_DATA_DIR", "./data"));
  const logDir = path.resolve(rootDir, env("REMOTE_PC_LOG_DIR", "./logs"));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const pin = (process.env.REMOTE_PC_PIN ?? "").trim();
  if (pin && !/^\d{8,12}$/.test(pin)) {
    throw new Error("REMOTE_PC_PIN must contain 8 to 12 digits.");
  }
  const serverPort = clamp(envInt("REMOTE_PC_PORT", fileConfig.server?.port ?? 8787), 1024, 65535);
  const adminPort = clamp(envInt("REMOTE_PC_ADMIN_PORT", 8788), 1024, 65535);
  if (serverPort === adminPort) {
    throw new Error("REMOTE_PC_PORT and REMOTE_PC_ADMIN_PORT must be different.");
  }

  return {
    rootDir,
    dataDir,
    logDir,
    secret: loadSecret(dataDir),
    server: {
      host: env("REMOTE_PC_HOST", fileConfig.server?.host ?? "127.0.0.1"),
      port: serverPort,
      publicBaseUrl: env("REMOTE_PC_PUBLIC_BASE_URL", fileConfig.server?.publicBaseUrl ?? "")
    },
    admin: {
      host: "127.0.0.1",
      port: adminPort,
      token: loadLocalKey(dataDir, "admin.key")
    },
    security: {
      pin,
      requireLocalApproval: envBool(
        "REMOTE_PC_REQUIRE_LOCAL_APPROVAL",
        fileConfig.security?.requireLocalApproval ?? true
      ),
      sessionHours: clamp(
        envInt("REMOTE_PC_SESSION_HOURS", fileConfig.security?.sessionHours ?? 8),
        1,
        24
      )
    },
    stream: {
      ffmpegPath: env("FFMPEG_PATH", "ffmpeg"),
      monitorIndex: envInt("STREAM_MONITOR_INDEX", fileConfig.stream?.monitorIndex ?? 0),
      fps: clamp(envInt("STREAM_FPS", fileConfig.stream?.fps ?? 60), 15, 60),
      width: envInt("STREAM_WIDTH", fileConfig.stream?.width ?? 1280),
      height: envInt("STREAM_HEIGHT", fileConfig.stream?.height ?? 720),
      captureBackend: captureBackend.parse(
        env("STREAM_CAPTURE_BACKEND", fileConfig.stream?.captureBackend ?? "gdigrab")
      ),
      preset: qualityPreset.parse(env("STREAM_PRESET", fileConfig.stream?.preset ?? "low-latency")),
      forceEncoder: env("STREAM_FORCE_ENCODER", fileConfig.stream?.forceEncoder ?? ""),
      rtpPort: envInt("STREAM_RTP_PORT", fileConfig.stream?.rtpPort ?? 5004),
      stunUrls: envList(
        "STREAM_STUN_URLS",
        fileConfig.stream?.stunUrls ?? ["stun:stun.l.google.com:19302"]
      ),
      turn: loadTurn(fileConfig.stream?.turn ?? [])
    },
    cloudflare: {
      enabled: envBool("CLOUDFLARE_ENABLED", fileConfig.cloudflare?.enabled ?? true),
      mode:
        env("CLOUDFLARE_MODE", fileConfig.cloudflare?.mode ?? "quick") === "named"
          ? "named"
          : "quick",
      cloudflaredPath: env(
        "CLOUDFLARED_PATH",
        fileConfig.cloudflare?.cloudflaredPath ?? "cloudflared"
      ),
      namedTunnelName: env(
        "CLOUDFLARE_NAMED_TUNNEL_NAME",
        fileConfig.cloudflare?.namedTunnelName ?? ""
      ),
      namedTunnelConfig: env(
        "CLOUDFLARE_NAMED_TUNNEL_CONFIG",
        fileConfig.cloudflare?.namedTunnelConfig ?? ""
      ),
      fixedDomain: env("CLOUDFLARE_FIXED_DOMAIN", fileConfig.cloudflare?.fixedDomain ?? "")
    },
    discord: {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? ""
    },
    input: {
      helperPath: env("INPUT_HELPER_PATH", ""),
      emergencyHotkey: env("EMERGENCY_HOTKEY", "CommandOrControl+Alt+Shift+F12")
    }
  };
}

function loadSecret(dataDir: string): string {
  const configured = process.env.REMOTE_PC_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error("REMOTE_PC_SECRET must contain at least 32 characters.");
    }
    return configured;
  }

  return loadLocalKey(dataDir, "secret.key");
}

function loadLocalKey(dataDir: string, filename: string): string {
  const secretPath = path.join(dataDir, filename);
  if (existsSync(secretPath)) {
    return readFileSync(secretPath, "utf8").trim();
  }

  const secret = cryptoRandom();
  writeFileSync(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  return secret;
}

function cryptoRandom(): string {
  return randomBytes(48).toString("base64url");
}

function loadTurn(fileTurn: Array<{ urls: string; username?: string; credential?: string }>) {
  const urls = envList("STREAM_TURN_URLS", []);
  if (urls.length === 0) {
    return fileTurn;
  }
  return urls.map((urlsValue) => ({
    urls: urlsValue,
    username: process.env.STREAM_TURN_USERNAME || undefined,
    credential: process.env.STREAM_TURN_CREDENTIAL || undefined
  }));
}

function env(name: string, fallback: string): string {
  return process.env[name] && process.env[name] !== "" ? process.env[name]! : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
