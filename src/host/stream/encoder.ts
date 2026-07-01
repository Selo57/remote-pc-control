import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export interface EncoderChoice {
  name: string;
  label: string;
  args: string[];
  hardware: boolean;
}

export async function chooseEncoder(
  config: AppConfig,
  excluded = new Set<string>()
): Promise<EncoderChoice> {
  const encoders = await listEncoders(config.stream.ffmpegPath);
  const forced = config.stream.forceEncoder;
  if (forced) {
    return encoderFor(forced, encoders);
  }

  for (const name of ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]) {
    if (encoders.has(name) && !excluded.has(name)) {
      return encoderFor(name, encoders);
    }
  }

  return encoderFor("libx264", encoders);
}

async function listEncoders(ffmpegPath: string): Promise<Set<string>> {
  try {
    const { stdout, stderr } = await execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const text = `${stdout}\n${stderr}`;
    return new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*[A-Z.]{6}\s+(\S+)/)?.[1])
        .filter((name): name is string => Boolean(name))
    );
  } catch {
    return new Set(["libx264"]);
  }
}

function encoderFor(name: string, available: Set<string>): EncoderChoice {
  if (!available.has(name) && name !== "libx264") {
    return encoderFor("libx264", available);
  }

  switch (name) {
    case "h264_nvenc":
      return {
        name,
        label: "NVIDIA NVENC",
        hardware: true,
        args: [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p1",
          "-tune",
          "ull",
          "-rc",
          "cbr",
          "-zerolatency",
          "1",
          "-bf",
          "0",
          "-forced-idr",
          "1"
        ]
      };
    case "h264_qsv":
      return {
        name,
        label: "Intel Quick Sync",
        hardware: true,
        args: ["-c:v", "h264_qsv", "-preset", "veryfast", "-look_ahead", "0", "-bf", "0"]
      };
    case "h264_amf":
      return {
        name,
        label: "AMD AMF",
        hardware: true,
        args: ["-c:v", "h264_amf", "-usage", "ultralowlatency", "-quality", "speed", "-bf", "0"]
      };
    default:
      return {
        name: "libx264",
        label: "x264 software",
        hardware: false,
        args: [
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-x264-params",
          "repeat-headers=1"
        ]
      };
  }
}
