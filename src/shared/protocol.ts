export type Permission = "view" | "control";

export type QualityPreset = "low-latency" | "balanced" | "high-quality";

export interface ClientStats {
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  width: number;
  height: number;
  droppedFrames: number;
  packetsLost: number;
}

export interface HostStatus {
  startedAt: string;
  serverUrl: string;
  remoteAccess: "disabled" | "connecting" | "online" | "error";
  cloudflareUrl?: string;
  activeSessions: number;
  inputEnabled: boolean;
  stream: {
    running: boolean;
    encoder: string;
    fps: number;
    bitrateKbps: number;
    resolution: string;
    droppedFrames: number;
  };
  health: Record<string, ComponentHealth>;
}

export interface ComponentHealth {
  ok: boolean;
  status: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  consecutiveFailures: number;
}

export type SignalClientMessage =
  | { type: "offer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "close" };

export type SignalServerMessage =
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "status"; status: "connecting" | "connected" | "closed" | "failed"; reason?: string }
  | { type: "error"; message: string };

export type InputButton = "left" | "right" | "middle";

export type ControlMessage =
  | { type: "mouseMove"; dx: number; dy: number }
  | { type: "mouseAbs"; x: number; y: number }
  | { type: "mouseButton"; button: InputButton; down: boolean }
  | { type: "click"; button: InputButton }
  | { type: "doubleClick"; button: InputButton }
  | { type: "wheel"; delta: number }
  | { type: "key"; key: string; down: boolean }
  | { type: "shortcut"; keys: string[] }
  | { type: "text"; text: string }
  | { type: "setQuality"; preset: QualityPreset }
  | { type: "selectMonitor"; monitorIndex: number }
  | { type: "ping"; sentAt: number };

export type ControlReply =
  | { type: "pong"; sentAt: number; receivedAt: number }
  | { type: "rejected"; reason: string }
  | { type: "quality"; preset: QualityPreset }
  | { type: "monitor"; monitorIndex: number };

export interface PinLoginRequest {
  pin: string;
  label?: string;
}

export interface SessionInfo {
  authenticated: boolean;
  pendingApproval?: boolean;
  csrfToken?: string;
  deviceLabel?: string;
  permission?: Permission;
  expiresAt?: string;
  pinLogin: boolean;
}

export interface TrustedDeviceInfo {
  id: string;
  label: string;
  permission: Permission;
  approved: boolean;
  createdAt: string;
  lastSeenAt: string;
}
