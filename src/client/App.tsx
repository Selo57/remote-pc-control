import {
  CircleDot,
  Gauge,
  Keyboard,
  Lock,
  Monitor,
  MousePointer2,
  Power,
  RefreshCw,
  Shield,
  Signal,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClientStats,
  ControlMessage,
  ControlReply,
  HostStatus,
  SessionInfo,
  SignalServerMessage,
  TrustedDeviceInfo
} from "../shared/protocol.js";

const zeroStats: ClientStats = {
  fps: 0,
  bitrateKbps: 0,
  latencyMs: 0,
  width: 0,
  height: 0,
  droppedFrames: 0,
  packetsLost: 0
};

export function App() {
  const hostMode = window.location.pathname.startsWith("/host");
  const [session, setSession] = useState<SessionInfo | undefined>();

  const refreshSession = useCallback(async () => {
    if (hostMode) {
      return;
    }
    const response = await fetch("/api/session", { credentials: "include" });
    setSession((await response.json()) as SessionInfo);
  }, [hostMode]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (hostMode) {
    return <HostPanel />;
  }

  if (!session) {
    return <Splash />;
  }

  if (!session.authenticated) {
    return <PinLogin initialPending={Boolean(session.pendingApproval)} onLoggedIn={setSession} />;
  }

  return <RemoteDesktop session={session} onSessionChanged={setSession} />;
}

function Splash() {
  return (
    <main className="screen center">
      <RefreshCw className="spin" />
    </main>
  );
}

function PinLogin({
  initialPending,
  onLoggedIn
}: {
  initialPending: boolean;
  onLoggedIn: (session: SessionInfo) => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(initialPending);

  useEffect(() => {
    if (!pending) {
      return;
    }
    const check = async () => {
      try {
        const response = await fetch("/api/session", { credentials: "include" });
        const body = (await response.json()) as SessionInfo;
        if (body.authenticated) {
          onLoggedIn(body);
        }
      } catch {
        // Keep polling while the local operator reviews the device.
      }
    };
    const timer = window.setInterval(() => void check(), 2_000);
    return () => window.clearInterval(timer);
  }, [onLoggedIn, pending]);

  async function login() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pin,
          label: navigator.userAgent.includes("iPhone") ? "iPhone" : "Remote browser"
        })
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "Login failed.");
      }
      setPending(Boolean(body.pendingApproval));
      onLoggedIn(body as SessionInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen auth">
      <section className="auth-panel">
        <div className="brand-row">
          <Shield />
          <div>
            <h1>Remote PC</h1>
            <p>{pending ? "Waiting for approval on the PC." : "Enter the PC control PIN."}</p>
          </div>
        </div>
        <label>
          PIN
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 12))}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            disabled={pending}
            autoFocus
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || pending || pin.length < 8} onClick={login}>
          <Lock size={18} />
          {pending ? "Awaiting approval" : "Connect"}
        </button>
      </section>
    </main>
  );
}

function RemoteDesktop({
  session,
  onSessionChanged
}: {
  session: SessionInfo;
  onSessionChanged: (session: SessionInfo) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const keyboardRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [status, setStatus] = useState("connecting");
  const [stats, setStats] = useState<ClientStats>(zeroStats);
  const [modifiers, setModifiers] = useState<Record<string, boolean>>({
    ctrl: false,
    alt: false,
    shift: false,
    win: false
  });
  const controlRef = useRef<RTCDataChannel | undefined>(undefined);
  const pcRef = useRef<RTCPeerConnection | undefined>(undefined);
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const reconnectRef = useRef<number | undefined>(undefined);
  const connectionGeneration = useRef(0);
  const pendingRemoteCandidates = useRef<RTCIceCandidateInit[]>([]);
  const videoProgressRef = useRef({ framesDecoded: 0, updatedAt: Date.now(), autoRefreshAt: 0 });
  const pendingMoveRef = useRef({ dx: 0, dy: 0 });
  const moveFrameRef = useRef<number | undefined>(undefined);

  const sendNow = useCallback((message: ControlMessage) => {
    const channel = controlRef.current;
    if (!channel || channel.readyState !== "open") {
      return false;
    }
    if (
      (message.type === "mouseMove" || message.type === "wheel") &&
      channel.bufferedAmount > 32_000
    ) {
      return false;
    }
    if (message.type !== "ping" && channel.bufferedAmount > 256_000) {
      return false;
    }
    channel.send(JSON.stringify(message));
    return true;
  }, []);

  const flushPendingMove = useCallback(() => {
    moveFrameRef.current = undefined;
    const move = pendingMoveRef.current;
    pendingMoveRef.current = { dx: 0, dy: 0 };
    if (move.dx || move.dy) {
      sendNow({ type: "mouseMove", dx: move.dx, dy: move.dy });
    }
  }, [sendNow]);

  const send = useCallback(
    (message: ControlMessage) => {
      if (message.type === "mouseMove") {
        pendingMoveRef.current = {
          dx: pendingMoveRef.current.dx + message.dx,
          dy: pendingMoveRef.current.dy + message.dy
        };
        if (moveFrameRef.current === undefined) {
          moveFrameRef.current = window.requestAnimationFrame(flushPendingMove);
        }
        return true;
      }

      if (moveFrameRef.current !== undefined) {
        window.cancelAnimationFrame(moveFrameRef.current);
        flushPendingMove();
      }
      return sendNow(message);
    },
    [flushPendingMove, sendNow]
  );

  const connect = useCallback(async () => {
    window.clearTimeout(reconnectRef.current);
    const generation = connectionGeneration.current + 1;
    connectionGeneration.current = generation;
    const previousPc = pcRef.current;
    if (previousPc) {
      previousPc.onconnectionstatechange = null;
      previousPc.close();
    }
    const previousWs = wsRef.current;
    if (previousWs) {
      previousWs.onclose = null;
      previousWs.close();
    }
    wsRef.current = undefined;
    controlRef.current = undefined;
    pendingRemoteCandidates.current = [];
    videoProgressRef.current = { framesDecoded: 0, updatedAt: Date.now(), autoRefreshAt: 0 };
    setStatus("connecting");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    pcRef.current = pc;

    const control = pc.createDataChannel("control", { ordered: false, maxRetransmits: 0 });
    controlRef.current = control;
    control.onmessage = (event) => {
      if (generation !== connectionGeneration.current) {
        return;
      }
      const reply = JSON.parse(event.data) as ControlReply;
      if (reply.type === "pong") {
        setStats((current) => ({ ...current, latencyMs: Math.max(0, Date.now() - reply.sentAt) }));
      }
    };

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (event) => {
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
      }
    };
    pc.onconnectionstatechange = () => {
      if (generation !== connectionGeneration.current) {
        return;
      }
      setStatus(pc.connectionState);
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        reconnectRef.current = window.setTimeout(() => void connect(), 1500);
      }
    };

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/signal`);
    wsRef.current = ws;
    ws.onmessage = async (event) => {
      if (generation !== connectionGeneration.current) {
        return;
      }
      const message = JSON.parse(event.data) as SignalServerMessage;
      if (message.type === "answer") {
        await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
        for (const candidate of pendingRemoteCandidates.current.splice(0)) {
          await pc.addIceCandidate(candidate);
        }
      } else if (message.type === "ice") {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(message.candidate);
        } else {
          pendingRemoteCandidates.current.push(message.candidate);
        }
      } else if (message.type === "status") {
        if (message.status === "closed" && message.reason === "newer session opened") {
          connectionGeneration.current += 1;
          window.clearTimeout(reconnectRef.current);
          pc.onconnectionstatechange = null;
          ws.onclose = null;
          pc.close();
          ws.close();
          setStatus("closed");
          return;
        }
        setStatus(message.status);
      }
    };
    ws.onclose = () => {
      if (generation !== connectionGeneration.current) {
        return;
      }
      setStatus("reconnecting");
      reconnectRef.current = window.setTimeout(() => void connect(), 1500);
    };
    pc.onicecandidate = (event) => {
      if (generation !== connectionGeneration.current) {
        return;
      }
      if (event.candidate && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ice", candidate: event.candidate.toJSON() }));
      }
    };

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
  }, [session.permission]);

  const refreshStream = useCallback(async () => {
    setStatus("refreshing stream");
    window.clearTimeout(reconnectRef.current);
    connectionGeneration.current += 1;

    const pc = pcRef.current;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.close();
    }
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    controlRef.current = undefined;
    wsRef.current = undefined;

    try {
      await fetch("/api/stream/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": session.csrfToken ?? "" }
      });
    } catch {
      // The reconnect below is still useful if the HTTP refresh races the socket teardown.
    }

    reconnectRef.current = window.setTimeout(() => void connect(), 350);
  }, [connect, session.csrfToken]);

  useEffect(() => {
    void connect();
    return () => {
      connectionGeneration.current += 1;
      window.clearTimeout(reconnectRef.current);
      if (moveFrameRef.current !== undefined) {
        window.cancelAnimationFrame(moveFrameRef.current);
        moveFrameRef.current = undefined;
      }
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      send({ type: "ping", sentAt: Date.now() });
      void updateStats(pcRef.current, videoRef.current, setStats).then((progress) => {
        if (!progress?.framesDecoded || status !== "connected") {
          return;
        }

        const current = videoProgressRef.current;
        if (progress.framesDecoded > current.framesDecoded) {
          videoProgressRef.current = {
            ...current,
            framesDecoded: progress.framesDecoded,
            updatedAt: Date.now()
          };
          return;
        }

        const now = Date.now();
        if (now - current.updatedAt > 7_000 && now - current.autoRefreshAt > 12_000) {
          videoProgressRef.current = { ...current, autoRefreshAt: now };
          void refreshStream();
        }
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshStream, send, status]);

  function toggleModifier(key: string) {
    const next = !modifiers[key];
    setModifiers((current) => ({ ...current, [key]: next }));
    send({ type: "key", key, down: next });
  }

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "x-csrf-token": session.csrfToken ?? "" }
    });
    onSessionChanged({ authenticated: false, pinLogin: true });
  }

  return (
    <main className="screen remote">
      <GestureSurface send={send} scale={scale} setScale={setScale}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="desktop-video"
          style={{ transform: `scale(${scale})` }}
        />
      </GestureSurface>

      {status !== "connected" && (
        <div className="reconnect">
          <RefreshCw className="spin" />
          <span>{status}</span>
        </div>
      )}

      <section className={`overlay ${collapsed ? "collapsed" : ""}`}>
        <header>
          <div className="pill">
            <Signal size={15} />
            {stats.latencyMs} ms
          </div>
          <button
            className="icon"
            onClick={() => setCollapsed((value) => !value)}
            aria-label="Toggle controls"
          >
            {collapsed ? <MousePointer2 /> : <X />}
          </button>
        </header>
        {!collapsed && (
          <>
            <div className="stats-grid">
              <Stat icon={<Gauge />} label="FPS" value={stats.fps} />
              <Stat icon={<Signal />} label="Kbps" value={stats.bitrateKbps} />
              <Stat icon={<Monitor />} label="Size" value={stats.width ? `${stats.width}p` : "0"} />
              <Stat icon={<CircleDot />} label="Drop" value={stats.droppedFrames} />
            </div>
            <div className="button-grid">
              <button onClick={() => send({ type: "click", button: "left" })}>Left</button>
              <button onClick={() => send({ type: "click", button: "right" })}>Right</button>
              <button onClick={() => send({ type: "click", button: "middle" })}>Middle</button>
              <button onClick={() => send({ type: "wheel", delta: 360 })}>Scroll up</button>
              <button onClick={() => send({ type: "wheel", delta: -360 })}>Scroll down</button>
              <button onClick={refreshStream}>
                <RefreshCw size={16} />
                Refresh stream
              </button>
              <button onClick={() => setKeyboardOpen((value) => !value)}>
                <Keyboard size={16} />
                Keys
              </button>
            </div>
            {keyboardOpen && (
              <div className="keyboard-panel">
                <div className="modifier-row">
                  {Object.keys(modifiers).map((key) => (
                    <button
                      key={key}
                      className={modifiers[key] ? "selected" : ""}
                      onClick={() => toggleModifier(key)}
                    >
                      {key}
                    </button>
                  ))}
                </div>
                <input
                  ref={keyboardRef}
                  placeholder="Type here"
                  autoCapitalize="off"
                  autoCorrect="off"
                  onInput={(event) => {
                    const value = event.currentTarget.value;
                    if (value) {
                      send({ type: "text", text: value });
                      event.currentTarget.value = "";
                    }
                  }}
                  onKeyDown={(event) => {
                    if (["Escape", "Enter", "Tab", "Backspace"].includes(event.key)) {
                      event.preventDefault();
                      send({ type: "click", button: "left" });
                      send({ type: "key", key: event.key, down: true });
                      send({ type: "key", key: event.key, down: false });
                    }
                  }}
                />
                <div className="button-grid">
                  {["Escape", "Enter", "Tab", "Backspace"].map((key) => (
                    <button key={key} onClick={() => send({ type: "shortcut", keys: [key] })}>
                      {key}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Joystick send={send} />
            <button className="danger" onClick={logout}>
              <Power size={16} />
              Disconnect
            </button>
          </>
        )}
      </section>
    </main>
  );
}

function GestureSurface({
  children,
  send,
  scale,
  setScale
}: {
  children: React.ReactNode;
  send: (message: ControlMessage) => boolean;
  scale: number;
  setScale: (scale: number) => void;
}) {
  const state = useRef({
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    startAt: 0,
    lastTap: 0,
    pinchDistance: 0,
    moved: false,
    longPress: 0,
    longPressed: false,
    maxTouches: 0,
    lastRightClickAt: 0
  });

  const rightClick = useCallback(() => {
    state.current.lastRightClickAt = Date.now();
    send({ type: "click", button: "right" });
  }, [send]);

  return (
    <div
      className="gesture-surface"
      onContextMenu={(event) => {
        event.preventDefault();
        if (Date.now() - state.current.lastRightClickAt > 500) {
          rightClick();
        }
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        const first = event.touches[0];
        state.current.startAt = Date.now();
        state.current.moved = false;
        state.current.longPressed = false;
        state.current.maxTouches = Math.max(state.current.maxTouches, event.touches.length);
        if (event.touches.length === 1 && first) {
          state.current.maxTouches = 1;
          state.current.startX = first.clientX;
          state.current.startY = first.clientY;
          state.current.lastX = first.clientX;
          state.current.lastY = first.clientY;
          window.clearTimeout(state.current.longPress);
          state.current.longPress = window.setTimeout(() => {
            state.current.longPressed = true;
            rightClick();
          }, 650);
        }
        if (event.touches.length === 2) {
          window.clearTimeout(state.current.longPress);
          state.current.maxTouches = 2;
          state.current.pinchDistance = distance(event.touches[0], event.touches[1]);
        }
      }}
      onTouchMove={(event) => {
        event.preventDefault();
        if (event.touches.length === 1) {
          const touch = event.touches[0];
          const dx = touch.clientX - state.current.lastX;
          const dy = touch.clientY - state.current.lastY;
          const distanceFromStart = Math.hypot(
            touch.clientX - state.current.startX,
            touch.clientY - state.current.startY
          );
          state.current.lastX = touch.clientX;
          state.current.lastY = touch.clientY;
          if (distanceFromStart > 8) {
            window.clearTimeout(state.current.longPress);
            state.current.moved = true;
          }
          if (Math.abs(dx) + Math.abs(dy) > 1) {
            send({ type: "mouseMove", dx: Math.round(dx * 1.5), dy: Math.round(dy * 1.5) });
          }
        }
        if (event.touches.length === 2) {
          window.clearTimeout(state.current.longPress);
          state.current.maxTouches = 2;
          const nextDistance = distance(event.touches[0], event.touches[1]);
          const previous = state.current.pinchDistance || nextDistance;
          const delta = nextDistance - previous;
          state.current.pinchDistance = nextDistance;
          if (Math.abs(delta) > 2) {
            setScale(Math.max(0.75, Math.min(3, scale + delta / 350)));
          } else {
            const y = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            const dy = y - state.current.lastY;
            state.current.lastY = y;
            if (Math.abs(dy) > 8) {
              send({ type: "wheel", delta: dy > 0 ? -180 : 180 });
            }
          }
        }
      }}
      onTouchEnd={(event) => {
        event.preventDefault();
        window.clearTimeout(state.current.longPress);
        if (state.current.longPressed) {
          state.current.longPressed = false;
          state.current.maxTouches = 0;
          return;
        }
        const elapsed = Date.now() - state.current.startAt;
        const tapLike = !state.current.moved && elapsed < 300;
        if (tapLike) {
          const now = Date.now();
          if (state.current.maxTouches >= 2) {
            rightClick();
          } else if (now - state.current.lastTap < 280) {
            send({ type: "doubleClick", button: "left" });
          } else {
            send({ type: "click", button: "left" });
          }
          state.current.lastTap = now;
        }
        if (event.touches.length === 0) {
          state.current.maxTouches = 0;
        }
      }}
    >
      {children}
    </div>
  );
}

function Joystick({ send }: { send: (message: ControlMessage) => boolean }) {
  const [active, setActive] = useState(false);
  const vector = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => {
      send({
        type: "mouseMove",
        dx: Math.round(vector.current.x),
        dy: Math.round(vector.current.y)
      });
    }, 35);
    return () => window.clearInterval(timer);
  }, [active, send]);

  return (
    <div
      className="joystick"
      onPointerDown={(event) => {
        setActive(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!active) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        vector.current = {
          x: ((event.clientX - rect.left) / rect.width - 0.5) * 24,
          y: ((event.clientY - rect.top) / rect.height - 0.5) * 24
        };
      }}
      onPointerUp={() => {
        setActive(false);
        vector.current = { x: 0, y: 0 };
      }}
    >
      <MousePointer2 />
    </div>
  );
}

function HostPanel() {
  const [adminToken] = useState(readAdminToken);
  const [status, setStatus] = useState<HostStatus | undefined>();
  const [devices, setDevices] = useState<TrustedDeviceInfo[]>([]);
  const [error, setError] = useState("");

  const update = useCallback(async () => {
    if (!adminToken) {
      return;
    }
    try {
      const [statusResponse, devicesResponse] = await Promise.all([
        adminFetch(adminToken, "/api/host/status"),
        adminFetch(adminToken, "/api/host/devices")
      ]);
      if (!statusResponse.ok || !devicesResponse.ok) {
        throw new Error("Local administrator authentication failed.");
      }
      setStatus((await statusResponse.json()) as HostStatus);
      setDevices((await devicesResponse.json()) as TrustedDeviceInfo[]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Status request failed.");
    }
  }, [adminToken]);

  useEffect(() => {
    if (!adminToken) {
      setError("Open this panel through Start-RemotePC.cmd or the tray application.");
      return;
    }
    void update();
    const timer = window.setInterval(update, 2000);
    return () => window.clearInterval(timer);
  }, [adminToken, update]);

  const health = useMemo(() => Object.entries(status?.health ?? {}), [status]);

  const runAction = useCallback(
    async (pathname: string, init: RequestInit = {}) => {
      if (!adminToken) {
        return;
      }
      const response = await adminFetch(adminToken, pathname, init);
      if (!response.ok) {
        setError("Local administrator action failed.");
        return;
      }
      await update();
    },
    [adminToken, update]
  );

  return (
    <main className="screen host">
      <section className="host-header">
        <div>
          <h1>Remote PC Host</h1>
          <p>{status?.cloudflareUrl ?? status?.serverUrl ?? "starting"}</p>
        </div>
        <span className={status?.activeSessions ? "live-dot active" : "live-dot"} />
      </section>
      <section className="host-grid">
        <Info label="PIN" value="configured locally" />
        <Info label="Remote" value={status?.remoteAccess ?? "starting"} />
        <Info label="Sessions" value={status?.activeSessions ?? 0} />
        <Info label="Input" value={status?.inputEnabled ? "enabled" : "disabled"} />
        <Info label="Encoder" value={status?.stream.encoder ?? "unknown"} />
        <Info
          label="Stream"
          value={`${status?.stream.fps ?? 0} FPS / ${status?.stream.bitrateKbps ?? 0} Kbps`}
        />
      </section>
      {error && <p className="error">{error}</p>}
      <section className="host-actions">
        <button onClick={() => void runAction("/api/host/sessions/kill", { method: "POST" })}>
          Kill session
        </button>
        <button onClick={() => void runAction("/api/host/input/disable", { method: "POST" })}>
          Disable input
        </button>
        <button onClick={() => void runAction("/api/host/input/enable", { method: "POST" })}>
          Enable input
        </button>
      </section>
      <section className="device-list">
        <h2>Trusted devices</h2>
        {devices.length === 0 && <p>No devices have logged in.</p>}
        {devices.map((device) => (
          <div key={device.id} className="device-row">
            <div>
              <strong>{device.label}</strong>
              <small>{device.approved ? "approved" : "awaiting approval"}</small>
            </div>
            <div className="device-actions">
              <button
                onClick={() =>
                  void runAction(`/api/host/devices/${device.id}/approve`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ approved: !device.approved })
                  })
                }
              >
                {device.approved ? "Block" : "Approve"}
              </button>
              <button
                onClick={() =>
                  void runAction(`/api/host/devices/${device.id}`, {
                    method: "DELETE"
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </section>
      <section className="health-list">
        {health.map(([name, item]) => (
          <div key={name}>
            <span className={item.ok ? "ok" : "bad"} />
            <strong>{name}</strong>
            <small>{item.status}</small>
          </div>
        ))}
      </section>
    </main>
  );
}

function readAdminToken() {
  try {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const supplied = hash.get("token");
    if (supplied) {
      window.sessionStorage.setItem("remotePcAdminToken", supplied);
      window.history.replaceState(null, "", window.location.pathname);
      return supplied;
    }
    return window.sessionStorage.getItem("remotePcAdminToken") ?? "";
  } catch {
    return "";
  }
}

function adminFetch(token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-remote-pc-admin-token", token);
  return fetch(pathname, { ...init, headers, credentials: "omit" });
}

function Stat({
  icon,
  label,
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="stat">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

async function updateStats(
  pc: RTCPeerConnection | undefined,
  video: HTMLVideoElement | null,
  setStats: (updater: (stats: ClientStats) => ClientStats) => void
) {
  if (!pc) {
    return undefined;
  }
  const report = await pc.getStats();
  let inboundStats: RTCInboundRtpStreamStats | undefined;
  report.forEach((stats) => {
    if (stats.type === "inbound-rtp" && stats.kind === "video") {
      inboundStats = stats as RTCInboundRtpStreamStats;
    }
  });
  if (!inboundStats) {
    return undefined;
  }
  const inbound = inboundStats as RTCInboundRtpStreamStats & { framesDecoded?: number };
  setStats((current) => ({
    ...current,
    fps: Math.round(inbound.framesPerSecond ?? current.fps),
    bitrateKbps: estimateBitrate(current.bitrateKbps, inbound.bytesReceived),
    width: video?.videoWidth ?? current.width,
    height: video?.videoHeight ?? current.height,
    droppedFrames: inbound.framesDropped ?? current.droppedFrames,
    packetsLost: inbound.packetsLost ?? current.packetsLost
  }));
  return { framesDecoded: inbound.framesDecoded };
}

let lastBytes = 0;
function estimateBitrate(previous: number, bytes?: number) {
  if (!bytes) {
    return previous;
  }
  const bitrate = Math.max(0, Math.round(((bytes - lastBytes) * 8) / 1000));
  lastBytes = bytes;
  return bitrate;
}

function distance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number }
) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
