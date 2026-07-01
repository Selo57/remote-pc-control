import { app, BrowserWindow, Menu, nativeImage, Tray, globalShortcut, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config.logDir);
let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let hostProcess: ChildProcess | undefined;
let sessionActive = false;
let quitting = false;

app.setLoginItemSettings({
  openAtLogin: true,
  path: process.execPath
});

app.whenReady().then(async () => {
  if (!(await publicHostAlive())) {
    startHost();
  }
  createTray();
  createWindow();
  registerEmergencyHotkey();
  pollStatus();
});

app.on("before-quit", () => {
  quitting = true;
  hostProcess?.kill();
});

function startHost() {
  const mainPath = path.join(config.rootDir, "dist", "host", "main.js");
  const child = spawn(process.execPath, [mainPath], {
    cwd: config.rootDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  hostProcess = child;
  child.stdout?.on("data", (chunk) => logger.info({ text: chunk.toString() }, "host stdout"));
  child.stderr?.on("data", (chunk) => logger.warn({ text: chunk.toString() }, "host stderr"));
  child.on("exit", (code, signal) => {
    logger.error({ code, signal }, "host process exited");
    hostProcess = undefined;
    if (!quitting) {
      setTimeout(startHost, 3_000);
    }
  });
}

function createTray() {
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("Remote PC");
  updateMenu();
}

function createWindow() {
  window = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    title: "Remote PC Host",
    webPreferences: {
      sandbox: true
    }
  });
  const token = encodeURIComponent(config.admin.token);
  void window.loadURL(`http://127.0.0.1:${config.admin.port}/host#token=${token}`);
  window.on("close", (event) => {
    event.preventDefault();
    window?.hide();
  });
}

function updateMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: sessionActive ? "Remote session active" : "No active remote session",
        enabled: false
      },
      {
        label: "Show Status",
        click: () => {
          window?.show();
          window?.focus();
        }
      },
      {
        label: "Open Local Web Client",
        click: () => void shell.openExternal(`http://127.0.0.1:${config.server.port}`)
      },
      {
        label: "Kill Remote Sessions",
        click: () => void postLocal("/api/host/sessions/kill")
      },
      {
        label: "Disable Remote Input",
        click: () => void postLocal("/api/host/input/disable")
      },
      {
        label: "Enable Remote Input",
        click: () => void postLocal("/api/host/input/enable")
      },
      { type: "separator" },
      {
        label: "Start With Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) =>
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath })
      },
      {
        label: "Quit",
        click: () => {
          hostProcess?.kill();
          app.exit(0);
        }
      }
    ])
  );
}

function registerEmergencyHotkey() {
  globalShortcut.register(config.input.emergencyHotkey, () => {
    void postLocal("/api/host/input/disable");
  });
}

async function pollStatus() {
  try {
    const response = await fetch(`http://127.0.0.1:${config.admin.port}/api/host/status`, {
      headers: adminHeaders()
    });
    if (response.ok) {
      const status = (await response.json()) as { activeSessions?: number; cloudflareUrl?: string };
      sessionActive = Boolean(status.activeSessions);
      tray?.setToolTip(status.cloudflareUrl ? `Remote PC: ${status.cloudflareUrl}` : "Remote PC");
      updateMenu();
    }
  } catch {
    tray?.setToolTip("Remote PC: host starting");
  } finally {
    setTimeout(pollStatus, 3_000);
  }
}

async function postLocal(pathname: string) {
  try {
    await fetch(`http://127.0.0.1:${config.admin.port}${pathname}`, {
      method: "POST",
      headers: adminHeaders()
    });
  } catch (error) {
    logger.warn({ error, pathname }, "local host command failed");
  }
}

async function publicHostAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${config.server.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function adminHeaders() {
  return { "x-remote-pc-admin-token": config.admin.token };
}
