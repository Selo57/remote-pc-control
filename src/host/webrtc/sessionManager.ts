import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCIceCandidate,
  useH264
} from "werift";
import type {
  ControlMessage,
  ControlReply,
  Permission,
  SignalClientMessage,
  SignalServerMessage
} from "../../shared/protocol.js";
import type { AppConfig } from "../config.js";
import type { InputService } from "../input/inputService.js";
import type { AppLogger } from "../logger.js";
import type { FfmpegRtpStreamer } from "../stream/ffmpegRtpStreamer.js";
import { controlMessageSchema } from "../validation.js";

interface PeerSession {
  id: string;
  pc: RTCPeerConnection;
  ws: WebSocket;
  track: MediaStreamTrack;
  permission: Permission;
  disposeStream: () => void;
}

const h264Codec = useH264({
  payloadType: 96,
  parameters: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  rtcpFeedback: [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
    { type: "transport-cc" }
  ]
});

export class WebRtcSessionManager extends EventEmitter {
  private readonly sessions = new Map<string, PeerSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly streamer: FfmpegRtpStreamer,
    private readonly input: InputService,
    private readonly logger: AppLogger
  ) {
    super();
  }

  activeCount() {
    return this.sessions.size;
  }

  async handleMessage(
    id: string,
    ws: WebSocket,
    permission: Permission,
    message: SignalClientMessage
  ) {
    if (message.type === "offer") {
      await this.handleOffer(id, ws, permission, message.sdp);
      return;
    }

    const session = this.sessions.get(id);
    if (!session) {
      this.send(ws, { type: "error", message: "Peer session has not been created." });
      return;
    }

    if (message.type === "ice") {
      await session.pc.addIceCandidate(message.candidate as RTCIceCandidate);
    } else if (message.type === "close") {
      await this.close(id, "client closed");
    }
  }

  async close(id: string, reason = "closed") {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    this.sessions.delete(id);
    session.disposeStream();
    this.streamer.removeConsumer();
    await session.pc.close();
    this.send(session.ws, { type: "status", status: "closed", reason });
    this.emit("sessionsChanged", this.sessions.size);
  }

  killAll(reason = "Remote session killed from host.") {
    void this.closeAll(reason);
  }

  async closeAll(reason = "closed") {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, reason)));
  }

  private async handleOffer(id: string, ws: WebSocket, permission: Permission, sdp: string) {
    await this.closeAll("newer session opened");

    const pc = new RTCPeerConnection({
      codecs: { video: [h264Codec] },
      iceServers: [
        ...this.config.stream.stunUrls.map((urls) => ({ urls })),
        ...this.config.stream.turn
      ]
    });

    const track = new MediaStreamTrack({ kind: "video", codec: h264Codec });
    const stream = new MediaStream([track]);
    pc.addTrack(track, stream);

    const onRtp = (packet: Buffer) => track.writeRtp(Buffer.from(packet));
    this.streamer.on("rtp", onRtp);
    this.streamer.addConsumer();

    const session: PeerSession = {
      id,
      pc,
      ws,
      track,
      permission,
      disposeStream: () => this.streamer.off("rtp", onRtp)
    };
    this.sessions.set(id, session);
    this.emit("sessionsChanged", this.sessions.size);

    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        this.send(ws, { type: "ice", candidate: candidate.toJSON() as RTCIceCandidateInit });
      }
    });

    pc.connectionStateChange.subscribe((state) => {
      this.logger.info({ id, state }, "webrtc state changed");
      if (state === "connected") {
        this.send(ws, { type: "status", status: "connected" });
      }
      if (state === "failed" || state === "closed" || state === "disconnected") {
        void this.close(id, state);
      }
    });

    pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== "control") {
        channel.close();
        return;
      }
      channel.onMessage.subscribe((data) => {
        const reply = this.handleControlMessage(session, data.toString());
        if (reply) {
          channel.send(JSON.stringify(reply));
        }
      });
    });

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send(ws, { type: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp });
    this.send(ws, { type: "status", status: "connecting" });
  }

  private handleControlMessage(session: PeerSession, raw: string): ControlReply | undefined {
    if (raw.length > 65_536) {
      return { type: "rejected", reason: "Control message is too large." };
    }

    let message: ControlMessage;
    try {
      message = controlMessageSchema.parse(JSON.parse(raw)) as ControlMessage;
    } catch {
      return { type: "rejected", reason: "Invalid control message." };
    }

    if (message.type === "ping") {
      return { type: "pong", sentAt: message.sentAt, receivedAt: Date.now() };
    }

    if (session.permission !== "control") {
      return { type: "rejected", reason: "This device is view-only." };
    }

    if (message.type === "setQuality") {
      void this.streamer.setQuality(message.preset);
      return { type: "quality", preset: message.preset };
    }

    if (message.type === "selectMonitor") {
      void this.streamer.selectMonitor(message.monitorIndex);
      return { type: "monitor", monitorIndex: message.monitorIndex };
    }

    const result = this.input.apply(message);
    if (!result.accepted) {
      return { type: "rejected", reason: result.reason ?? "Input command rejected." };
    }
    return undefined;
  }

  private send(ws: WebSocket, message: SignalServerMessage) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
