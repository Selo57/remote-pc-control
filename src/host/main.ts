import { createAdminServer, createPublicServer } from "./server.js";
import { AuthService } from "./auth.js";
import { CloudflaredSupervisor } from "./cloudflare/cloudflaredSupervisor.js";
import { loadConfig } from "./config.js";
import { DiscordNotifier } from "./discord.js";
import { InputService } from "./input/inputService.js";
import { createLogger } from "./logger.js";
import { StatusModel } from "./status.js";
import { LocalStore } from "./store.js";
import { FfmpegRtpStreamer } from "./stream/ffmpegRtpStreamer.js";
import { Watchdog } from "./watchdog.js";
import { WebRtcSessionManager } from "./webrtc/sessionManager.js";

const config = loadConfig();
const logger = createLogger(config.logDir);
const store = new LocalStore(config.dataDir);
const auth = new AuthService(config, store);
const discord = new DiscordNotifier(config, logger);
const input = new InputService(config, logger);
const streamer = new FfmpegRtpStreamer(config, logger);
const serverUrl = `http://127.0.0.1:${config.server.port}`;
const status = new StatusModel(serverUrl);
const cloudflare = new CloudflaredSupervisor(config, logger, discord);
const webrtc = new WebRtcSessionManager(config, streamer, input, logger);
const serverDeps = {
  config,
  auth,
  store,
  status,
  input,
  streamer,
  webrtc,
  logger
};
const publicServer = createPublicServer(serverDeps);
const adminServer = createAdminServer(serverDeps);
const watchdog = new Watchdog({
  server: publicServer,
  cloudflare,
  input,
  streamer,
  status,
  discord,
  logger
});
let streamHadCrash = false;
let shuttingDown = false;

input.on("enabled", (enabled) => status.setInputEnabled(Boolean(enabled)));
streamer.on("stats", (stats) => status.setStream(stats));
streamer.on("exit", () => {
  streamHadCrash = true;
});
streamer.on("started", () => {
  if (streamHadCrash) {
    streamHadCrash = false;
    void discord.send("Remote PC stream recovered.");
  }
});
webrtc.on("sessionsChanged", (count) => {
  status.setActiveSessions(Number(count));
  if (Number(count) > 0) {
    logger.warn("remote session active");
  }
});
cloudflare.on("status", (event: { status: string; url: string }) => {
  const remoteStatus =
    event.status === "online"
      ? "online"
      : event.status === "disabled"
        ? "disabled"
        : event.status === "error"
          ? "error"
          : "connecting";
  status.setCloudflare(remoteStatus, event.url);
});
cloudflare.on("url", (url) => logger.info({ url }, "cloudflare url changed"));

adminServer.on("error", fatalServerError("admin"));
publicServer.on("error", fatalServerError("public"));

adminServer.listen(config.admin.port, config.admin.host, () => {
  logger.info(
    { port: config.admin.port, host: config.admin.host },
    "local administration server listening"
  );
  publicServer.listen(config.server.port, config.server.host, () => {
    logger.info(
      { port: config.server.port, host: config.server.host },
      "remote pc public host listening"
    );
    input.start();
    cloudflare.start();
    watchdog.start();
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "uncaught exception");
  void discord.send("Remote PC needs attention.");
});
process.on("unhandledRejection", (error) => {
  logger.fatal({ error }, "unhandled rejection");
  void discord.send("Remote PC needs attention.");
});

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("shutting down remote pc host");
  watchdog.stop();
  cloudflare.stop();
  streamer.stop();
  input.stop();
  let remaining = 2;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) {
      store.close();
      process.exit(0);
    }
  };
  publicServer.close(closed);
  adminServer.close(closed);
}

function fatalServerError(component: string) {
  return (error: Error) => {
    logger.fatal({ error, component }, "server failed");
    shutdown();
  };
}
