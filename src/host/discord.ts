import type { AppConfig } from "./config.js";
import type { AppLogger } from "./logger.js";

export class DiscordNotifier {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {}

  async send(content: string) {
    if (!this.config.discord.webhookUrl) {
      return;
    }

    if (containsSensitive(content)) {
      this.logger.warn("blocked Discord notification that looked sensitive");
      return;
    }

    try {
      const response = await fetch(this.config.discord.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content })
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status }, "Discord notification failed");
      } else {
        this.logger.info("Discord notification sent");
      }
    } catch (error) {
      this.logger.warn({ error }, "Discord notification error");
    }
  }
}

function containsSensitive(content: string) {
  return /pairing|secret|token|password|pin|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./i.test(
    content
  );
}
