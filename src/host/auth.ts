import cookie from "cookie";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { LocalStore } from "./store.js";
import type { Permission, PinLoginRequest, SessionInfo } from "../shared/protocol.js";

const sessionClaimsSchema = z.object({
  deviceId: z.string().min(1).max(64),
  deviceLabel: z.string().min(1).max(80),
  permission: z.enum(["view", "control"]),
  csrfToken: z.string().min(32).max(128),
  expiresAt: z.number().int().positive()
});

export interface SessionClaims {
  deviceId: string;
  deviceLabel: string;
  permission: Permission;
  csrfToken: string;
  expiresAt: number;
}

export interface LoginResult {
  session: SessionClaims;
  approved: boolean;
}

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly store: LocalStore
  ) {}

  sessionInfo(req: IncomingMessage): SessionInfo {
    const claims = this.readClaims(req);
    if (!claims || claims.expiresAt <= Date.now()) {
      return { authenticated: false, pinLogin: true };
    }

    const device = this.store.getTrustedDevice(claims.deviceId);
    if (!device) {
      return { authenticated: false, pinLogin: true };
    }
    if (!device.approved) {
      return {
        authenticated: false,
        pendingApproval: true,
        deviceLabel: claims.deviceLabel,
        expiresAt: new Date(claims.expiresAt).toISOString(),
        pinLogin: true
      };
    }

    const session = { ...claims, permission: leastPrivilege(claims.permission, device.permission) };
    this.store.touchDevice(claims.deviceId);
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      deviceLabel: session.deviceLabel,
      permission: session.permission,
      expiresAt: new Date(session.expiresAt).toISOString(),
      pinLogin: true
    };
  }

  async login(
    req: IncomingMessage,
    res: ServerResponse,
    body: PinLoginRequest
  ): Promise<LoginResult> {
    const key = clientKey(req);
    const clientLimit = this.store.consumeLoginAttempt(`client:${key}`, 8, 10 * 60_000);
    const globalLimit = this.store.consumeLoginAttempt("global", 60, 10 * 60_000);
    if (!clientLimit.allowed || !globalLimit.allowed) {
      this.store.audit("pin_login_rate_limited", { ip: key });
      await delay(750);
      throw httpError(429, "Too many PIN attempts. Try again later.");
    }

    if (!this.config.security.pin) {
      throw httpError(403, "Control PIN is not configured on the host.");
    }

    if (!body.pin || !constantEqual(body.pin, this.config.security.pin)) {
      this.store.audit("pin_login_failed", { ip: key, label: body.label ?? "Remote browser" });
      await delay(Math.min(1_000, 150 + clientLimit.count * 75));
      throw httpError(401, "Invalid PIN.");
    }

    const deviceId = nanoid(24);
    const label = (body.label ?? "Remote browser").trim().slice(0, 80) || "Remote browser";
    const approved = !this.config.security.requireLocalApproval;
    this.store.addTrustedDevice({ id: deviceId, label, permission: "control", approved });
    this.store.resetLoginAttempts(`client:${key}`);

    const claims = this.createSession(deviceId, label, "control");
    this.setCookies(req, res, claims);
    return { session: claims, approved };
  }

  createSession(deviceId: string, deviceLabel: string, permission: Permission): SessionClaims {
    return {
      deviceId,
      deviceLabel,
      permission,
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: Date.now() + this.config.security.sessionHours * 60 * 60_000
    };
  }

  verifyRequest(req: IncomingMessage): SessionClaims | undefined {
    const claims = this.readClaims(req);
    if (!claims || claims.expiresAt <= Date.now()) {
      return undefined;
    }

    const device = this.store.getTrustedDevice(claims.deviceId);
    if (!device || !device.approved) {
      return undefined;
    }

    this.store.touchDevice(claims.deviceId);
    return { ...claims, permission: leastPrivilege(claims.permission, device.permission) };
  }

  requireSession(req: IncomingMessage): SessionClaims {
    const session = this.verifyRequest(req);
    if (!session) {
      throw httpError(401, "Authentication required.");
    }
    return session;
  }

  requireControl(req: IncomingMessage): SessionClaims {
    const session = this.requireSession(req);
    if (session.permission !== "control") {
      throw httpError(403, "Full control permission required.");
    }
    return session;
  }

  requireCsrf(req: IncomingMessage, session: SessionClaims) {
    const header = req.headers["x-csrf-token"];
    if (header !== session.csrfToken) {
      throw httpError(403, "CSRF token mismatch.");
    }
  }

  clearCookies(req: IncomingMessage, res: ServerResponse) {
    const secure = isSecure(req);
    res.setHeader("Set-Cookie", [
      cookie.serialize("rpc_session", "", {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        expires: new Date(0)
      })
    ]);
  }

  private setCookies(req: IncomingMessage, res: ServerResponse, claims: SessionClaims) {
    const secure = isSecure(req);
    res.setHeader("Set-Cookie", [
      cookie.serialize("rpc_session", this.signToken(claims), {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        expires: new Date(claims.expiresAt)
      })
    ]);
  }

  private signToken(claims: SessionClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = hmac(this.config.secret, payload);
    return `${payload}.${signature}`;
  }

  private verifyToken(token: string): SessionClaims | undefined {
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !constantEqual(hmac(this.config.secret, payload), signature)) {
      return undefined;
    }

    try {
      return sessionClaimsSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      ) as SessionClaims;
    } catch {
      return undefined;
    }
  }

  private readClaims(req: IncomingMessage): SessionClaims | undefined {
    const rawCookie = req.headers.cookie ?? "";
    const token = cookie.parse(rawCookie).rpc_session;
    return token ? this.verifyToken(token) : undefined;
  }
}

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function hmac(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function leastPrivilege(session: Permission, device: Permission): Permission {
  return session === "control" && device === "control" ? "control" : "view";
}

function clientKey(req: IncomingMessage) {
  const cloudflareIp = req.headers["cf-connecting-ip"];
  if (typeof cloudflareIp === "string" && cloudflareIp.length <= 64) {
    return cloudflareIp.trim() || "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isSecure(req: IncomingMessage) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.localPort === 443;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
