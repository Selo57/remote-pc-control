import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { SignalClientMessage } from "../shared/protocol.js";
import { AuthService, httpError, type SessionClaims } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { InputService } from "./input/inputService.js";
import type { AppLogger } from "./logger.js";
import type { StatusModel } from "./status.js";
import type { LocalStore } from "./store.js";
import type { FfmpegRtpStreamer } from "./stream/ffmpegRtpStreamer.js";
import {
  deviceApprovalSchema,
  deviceIdSchema,
  pinLoginSchema,
  qualityRequestSchema,
  signalClientMessageSchema
} from "./validation.js";
import type { WebRtcSessionManager } from "./webrtc/sessionManager.js";

export interface ServerDeps {
  config: AppConfig;
  auth: AuthService;
  store: LocalStore;
  status: StatusModel;
  input: InputService;
  streamer: FfmpegRtpStreamer;
  webrtc: WebRtcSessionManager;
  logger: AppLogger;
}

export function createPublicServer(deps: ServerDeps): Server {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(securityHeaders);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/session", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(deps.auth.sessionInfo(req));
  });

  app.post(
    "/api/auth/login",
    asyncHandler(async (req, res) => {
      const body = pinLoginSchema.parse(req.body);
      const result = await deps.auth.login(req, res, body);
      const { session, approved } = result;
      deps.logger.info(
        {
          deviceId: session.deviceId,
          label: session.deviceLabel,
          permission: session.permission,
          approved
        },
        approved ? "PIN login accepted" : "PIN login awaiting local approval"
      );
      res.setHeader("cache-control", "no-store");
      res.json({
        authenticated: approved,
        pendingApproval: !approved,
        csrfToken: approved ? session.csrfToken : undefined,
        deviceLabel: session.deviceLabel,
        permission: approved ? session.permission : undefined,
        expiresAt: new Date(session.expiresAt).toISOString(),
        pinLogin: true
      });
    })
  );

  app.post(
    "/api/auth/logout",
    asyncHandler((req, res) => {
      const session = deps.auth.requireSession(req);
      deps.auth.requireCsrf(req, session);
      deps.auth.clearCookies(req, res);
      res.json({ ok: true });
    })
  );

  app.post(
    "/api/stream/quality",
    asyncHandler(async (req, res) => {
      const session = deps.auth.requireControl(req);
      deps.auth.requireCsrf(req, session);
      const { preset } = qualityRequestSchema.parse(req.body);
      await deps.streamer.setQuality(preset);
      res.json({ ok: true, preset });
    })
  );

  app.post(
    "/api/stream/refresh",
    asyncHandler(async (req, res) => {
      const session = deps.auth.requireControl(req);
      deps.auth.requireCsrf(req, session);
      await deps.webrtc.closeAll("Stream refresh requested.");
      await deps.streamer.restart();
      res.json({ ok: true });
    })
  );

  app.use("/api/host", (_req, res) => res.status(404).json({ error: "Not found." }));
  app.use("/host", (_req, res) => res.status(404).type("text").send("Not found."));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  serveClient(app, deps.config.rootDir);
  app.use(errorHandler(deps.logger));

  const server = createServer(app);
  attachSignaling(server, deps);
  return server;
}

export function createAdminServer(deps: ServerDeps): Server {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(securityHeaders);
  app.use("/api/host", requireAdminToken(deps.config.admin.token));

  app.get("/api/host/status", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(deps.status.snapshot());
  });

  app.post("/api/host/input/disable", (_req, res) => {
    deps.input.setEnabled(false);
    deps.webrtc.killAll("Remote input disabled on host.");
    res.json({ ok: true });
  });

  app.post("/api/host/input/enable", (_req, res) => {
    deps.input.setEnabled(true);
    res.json({ ok: true });
  });

  app.post("/api/host/sessions/kill", (_req, res) => {
    deps.webrtc.killAll("Remote session killed from host.");
    res.json({ ok: true });
  });

  app.get("/api/host/devices", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json(deps.store.listTrustedDevices());
  });

  app.post(
    "/api/host/devices/:id/approve",
    asyncHandler((req, res) => {
      const id = deviceIdSchema.parse(String(req.params.id));
      const { approved } = deviceApprovalSchema.parse(req.body);
      deps.store.approveDevice(id, approved);
      if (!approved) {
        deps.webrtc.killAll("A trusted device was blocked on the host.");
      }
      res.json({ ok: true });
    })
  );

  app.delete(
    "/api/host/devices/:id",
    asyncHandler((req, res) => {
      deps.store.revokeDevice(deviceIdSchema.parse(String(req.params.id)));
      deps.webrtc.killAll("A trusted device was removed on the host.");
      res.json({ ok: true });
    })
  );

  app.get("/", (_req, res) => res.redirect("/host"));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
  serveClient(app, deps.config.rootDir);
  app.use(errorHandler(deps.logger));
  return createServer(app);
}

function attachSignaling(server: Server, deps: ServerDeps) {
  const signal = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false
  });

  server.on("upgrade", (req, socket, head) => {
    try {
      const host = req.headers.host;
      if (!host || !isAllowedWebSocketOrigin(req, deps.config)) {
        throw httpError(403, "WebSocket origin rejected.");
      }

      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== "/ws/signal") {
        socket.destroy();
        return;
      }

      const session = deps.auth.requireSession(req);
      signal.handleUpgrade(req, socket, head, (ws) => signal.emit("connection", ws, req, session));
    } catch {
      socket.destroy();
    }
  });

  signal.on("connection", (ws: WebSocket, _req: IncomingMessage, session: SessionClaims) => {
    const id = nanoid(12);
    const permission = session.permission;
    ws.on("message", (raw) => {
      try {
        const message = signalClientMessageSchema.parse(
          JSON.parse(raw.toString())
        ) as SignalClientMessage;
        void deps.webrtc.handleMessage(id, ws, permission, message);
      } catch (error) {
        deps.logger.warn({ error }, "bad signal message");
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid signaling message." }));
        }
      }
    });
    ws.on("close", () => void deps.webrtc.close(id, "websocket closed"));
  });
}

function isAllowedWebSocketOrigin(req: IncomingMessage, config: AppConfig) {
  const originHeader = req.headers.origin;
  const host = req.headers.host;
  if (typeof originHeader !== "string" || !host) {
    return false;
  }

  try {
    const origin = new URL(originHeader);
    if (!["http:", "https:"].includes(origin.protocol)) {
      return false;
    }
    if (origin.host.toLowerCase() === host.toLowerCase()) {
      return true;
    }
    return Boolean(
      config.server.publicBaseUrl && origin.origin === new URL(config.server.publicBaseUrl).origin
    );
  } catch {
    return false;
  }
}

function requireAdminToken(expectedToken: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const supplied = req.get("x-remote-pc-admin-token") ?? "";
    if (!safeEqual(supplied, expectedToken)) {
      next(httpError(401, "Local administrator token required."));
      return;
    }
    next();
  };
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function serveClient(app: express.Express, rootDir: string) {
  const clientDist = path.join(rootDir, "dist", "client");
  app.use(express.static(clientDist));
  app.use((_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"), (error) => {
      if (error && !res.headersSent) {
        res
          .status(200)
          .type("html")
          .send(
            "<!doctype html><title>Remote PC</title><p>Build the web client with <code>npm run build:web</code>, or run <code>npm run dev</code>.</p>"
          );
      }
    });
  });
}

function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
}

function errorHandler(logger: AppLogger) {
  return (
    error: Error & { status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const status = error.status ?? (error instanceof z.ZodError ? 400 : 500);
    logger.warn({ error, status }, "http request failed");
    const message = status >= 500 ? "Internal server error." : error.message;
    res.status(status).json({ error: message });
  };
}

function asyncHandler(handler: (req: Request, res: Response) => unknown | Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}
