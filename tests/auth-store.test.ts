import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthService } from "../src/host/auth.js";
import type { AppConfig } from "../src/host/config.js";
import { LocalStore } from "../src/host/store.js";
import {
  controlMessageSchema,
  pinLoginSchema,
  signalClientMessageSchema
} from "../src/host/validation.js";

test("login throttling persists across store restarts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-pc-rate-limit-"));
  try {
    const first = new LocalStore(directory);
    assert.equal(first.consumeLoginAttempt("client:test", 2, 60_000).allowed, true);
    assert.equal(first.consumeLoginAttempt("client:test", 2, 60_000).allowed, true);
    first.close();

    const reopened = new LocalStore(directory);
    assert.equal(reopened.consumeLoginAttempt("client:test", 2, 60_000).allowed, false);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("security-sensitive request schemas reject weak or oversized input", () => {
  assert.equal(pinLoginSchema.safeParse({ pin: "1234" }).success, false);
  assert.equal(pinLoginSchema.safeParse({ pin: "12345678" }).success, true);

  assert.equal(
    signalClientMessageSchema.safeParse({
      type: "offer",
      sdp: "x".repeat(256_001)
    }).success,
    false
  );

  assert.equal(
    controlMessageSchema.safeParse({
      type: "text",
      text: "x".repeat(4_097)
    }).success,
    false
  );
  assert.equal(
    controlMessageSchema.safeParse({
      type: "mouseMove",
      dx: Number.POSITIVE_INFINITY,
      dy: 0
    }).success,
    false
  );
});

test("new devices remain pending until the local administrator approves them", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "remote-pc-approval-"));
  const store = new LocalStore(directory);
  try {
    const config = {
      secret: "test-secret-that-is-longer-than-thirty-two-characters",
      security: {
        pin: "12345678",
        requireLocalApproval: true,
        sessionHours: 8
      }
    } as AppConfig;
    const auth = new AuthService(config, store);
    let setCookie: string[] = [];
    const request = {
      headers: {},
      socket: { remoteAddress: "203.0.113.10", localPort: 8787 }
    } as IncomingMessage;
    const response = {
      setHeader: (_name: string, value: string[]) => {
        setCookie = value;
      }
    } as unknown as ServerResponse;

    const login = await auth.login(request, response, {
      pin: "12345678",
      label: "Test browser"
    });
    assert.equal(login.approved, false);
    assert.equal(setCookie.length, 1);

    request.headers.cookie = setCookie[0]?.split(";")[0];
    assert.equal(auth.sessionInfo(request).pendingApproval, true);

    store.approveDevice(login.session.deviceId, true);
    assert.equal(auth.sessionInfo(request).authenticated, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
