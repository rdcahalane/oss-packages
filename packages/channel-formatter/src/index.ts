/**
 * channel-formatter
 *
 * Format AI response Markdown for different messaging channels.
 * Pure functions — zero runtime dependencies.
 *
 * Usage:
 *   import { formatForChannel } from "channel-formatter";
 *
 *   const chunks = formatForChannel(markdownText, "telegram");
 *   for (const chunk of chunks) await sendMessage(chunk);
 */

export type Channel = "telegram" | "slack" | "teams" | "sms";

const MAX_TELEGRAM_MSG = 4096;
const MAX_SLACK_MSG    = 3000;
const MAX_SMS_MSG      = 1600; // ~10 concatenated SMS segments
const MAX_TEAMS_MSG    = 4000;

/**
 * Convert Markdown to Telegram MarkdownV2 format.
 * Telegram MarkdownV2 requires escaping many special characters.
 */
function toTelegramMarkdown(text: string): string {
  let out = text;

  // Headers → bold line
  out = out.replace(/^#{1,3}\s+(.+)$/gm, "*$1*");

  // **bold** → *bold*
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Escape special chars outside code spans
  const parts = out.split(/(```[\s\S]*?```|`[^`]+`)/g);
  out = parts.map((part, i) => {
    if (i % 2 === 1) return part; // code span — leave as-is
    return part.replace(/([_\[\]()~>#+=|{}.!\-])/g, "\\$1");
  }).join("");

  return out;
}

/**
 * Convert Markdown to Slack mrkdwn format.
 */
function toSlackMarkdown(text: string): string {
  let out = text;
  // Headers → *bold*
  out = out.replace(/^#{1,3}\s+(.+)$/gm, "*$1*");
  // **bold** → *bold*
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  // `inline code` stays same; Slack renders - and * as bullets natively
  return out;
}

/**
 * Strip all Markdown for plain-text channels (SMS).
 */
function toPlainText(text: string): string {
  let out = text;
  out = out.replace(/^#{1,3}\s+/gm, "");            // remove header markers
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");       // **bold** → bold
  out = out.replace(/`([^`]+)`/g, "$1");              // `code` → code
  out = out.replace(/```[\s\S]*?```/g, "[code block]"); // code blocks
  out = out.replace(/^[-*]\s/gm, "• ");               // bullets
  return out.trim();
}

/**
 * Split a long message into chunks that fit within the channel limit.
 * Tries to split on paragraph boundaries to preserve readability.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks.filter(Boolean);
}

/**
 * Format and split a Markdown message for the given channel.
 * Returns an array of strings to send sequentially.
 *
 * @param text    - Markdown text produced by your AI
 * @param channel - Target channel
 * @returns       - Array of message chunks, each within the channel's size limit
 */
export function formatForChannel(text: string, channel: Channel): string[] {
  switch (channel) {
    case "telegram":
      return splitMessage(toTelegramMarkdown(text), MAX_TELEGRAM_MSG);
    case "slack":
      return splitMessage(toSlackMarkdown(text), MAX_SLACK_MSG);
    case "sms":
      return splitMessage(toPlainText(text), MAX_SMS_MSG);
    case "teams":
    default:
      // Teams supports a Markdown subset similar to standard
      return splitMessage(text, MAX_TEAMS_MSG);
  }
}
