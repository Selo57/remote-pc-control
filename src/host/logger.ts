import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";

class RotatingFileStream extends Writable {
  private stream;

  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly maxFiles = 5
  ) {
    super();
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = createWriteStream(filePath, { flags: "a" });
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ) {
    try {
      this.rotateIfNeeded(chunk.length);
      this.stream.write(chunk, encoding, callback);
    } catch (error) {
      callback(error as Error);
    }
  }

  private rotateIfNeeded(incomingBytes: number) {
    const currentBytes = existsSync(this.filePath) ? statSync(this.filePath).size : 0;
    if (currentBytes + incomingBytes < this.maxBytes) {
      return;
    }

    this.stream.end();
    for (let index = this.maxFiles - 1; index >= 1; index--) {
      const source = `${this.filePath}.${index}`;
      const target = `${this.filePath}.${index + 1}`;
      if (existsSync(source)) {
        renameSync(source, target);
      }
    }
    if (existsSync(this.filePath)) {
      renameSync(this.filePath, `${this.filePath}.1`);
    }
    this.stream = createWriteStream(this.filePath, { flags: "a" });
  }
}

export function createLogger(logDir: string) {
  const file = new RotatingFileStream(path.join(logDir, "host.log"));
  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.multistream([{ stream: process.stdout }, { stream: file }])
  );
}

export type AppLogger = ReturnType<typeof createLogger>;
