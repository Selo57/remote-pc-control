import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { TrustedDeviceInfo } from "../shared/protocol.js";

export type TrustedDevice = TrustedDeviceInfo;

export interface LoginAttemptResult {
  allowed: boolean;
  count: number;
  resetAt: number;
}

export class LocalStore {
  private readonly db: DatabaseSync;
  private auditWrites = 0;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "remote-pc.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        permission TEXT NOT NULL,
        approved INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        attempt_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
    `);
    this.db.prepare("DELETE FROM login_attempts WHERE reset_at <= ?").run(Date.now());
  }

  close() {
    this.db.close();
  }

  addTrustedDevice(input: Pick<TrustedDevice, "id" | "label" | "permission" | "approved">) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO trusted_devices (id, label, permission, approved, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.id, input.label, input.permission, input.approved ? 1 : 0, now, now);
    this.audit("trusted_device_added", {
      id: input.id,
      label: input.label,
      permission: input.permission,
      approved: input.approved
    });
  }

  getTrustedDevice(id: string): TrustedDevice | undefined {
    const row = this.db.prepare("SELECT * FROM trusted_devices WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return undefined;
    }
    return mapDevice(row);
  }

  listTrustedDevices(): TrustedDevice[] {
    return this.db
      .prepare("SELECT * FROM trusted_devices ORDER BY last_seen_at DESC")
      .all()
      .map((row) => mapDevice(row as Record<string, unknown>));
  }

  approveDevice(id: string, approved: boolean) {
    this.db
      .prepare("UPDATE trusted_devices SET approved = ? WHERE id = ?")
      .run(approved ? 1 : 0, id);
    this.audit(approved ? "trusted_device_approved" : "trusted_device_blocked", { id });
  }

  revokeDevice(id: string) {
    this.db.prepare("DELETE FROM trusted_devices WHERE id = ?").run(id);
    this.audit("trusted_device_revoked", { id });
  }

  touchDevice(id: string) {
    this.db
      .prepare("UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  consumeLoginAttempt(key: string, maxAttempts: number, windowMs: number): LoginAttemptResult {
    const now = Date.now();
    this.db.prepare("DELETE FROM login_attempts WHERE reset_at <= ?").run(now);
    const row = this.db
      .prepare("SELECT count, reset_at FROM login_attempts WHERE attempt_key = ?")
      .get(key) as { count: number; reset_at: number } | undefined;

    if (!row) {
      const resetAt = now + windowMs;
      this.db
        .prepare("INSERT INTO login_attempts (attempt_key, count, reset_at) VALUES (?, 1, ?)")
        .run(key, resetAt);
      return { allowed: true, count: 1, resetAt };
    }

    const count = Number(row.count) + 1;
    this.db.prepare("UPDATE login_attempts SET count = ? WHERE attempt_key = ?").run(count, key);
    return { allowed: count <= maxAttempts, count, resetAt: Number(row.reset_at) };
  }

  resetLoginAttempts(key: string) {
    this.db.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").run(key);
  }

  audit(event: string, detail: Record<string, unknown>) {
    this.db
      .prepare("INSERT INTO audit_log (event, detail, created_at) VALUES (?, ?, ?)")
      .run(event, JSON.stringify(detail), new Date().toISOString());
    this.auditWrites += 1;
    if (this.auditWrites % 100 === 0) {
      this.db.exec(`
        DELETE FROM audit_log
        WHERE id NOT IN (
          SELECT id FROM audit_log ORDER BY id DESC LIMIT 5000
        )
      `);
    }
  }
}

function mapDevice(row: Record<string, unknown>): TrustedDevice {
  return {
    id: String(row.id),
    label: String(row.label),
    permission: row.permission === "view" ? "view" : "control",
    approved: Boolean(row.approved),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at)
  };
}
