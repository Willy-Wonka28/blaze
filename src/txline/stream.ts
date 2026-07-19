import type { SseMessage } from "./types.js";

export function parseSseBlock(block: string): SseMessage | null {
  const message: SseMessage = { data: "" };

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;

    const separatorIndex = rawLine.indexOf(":");
    const field = separatorIndex === -1 ? rawLine : rawLine.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ""
        : rawLine.slice(separatorIndex + 1).replace(/^ /, "");

    if (field === "data") message.data += `${value}\n`;
    if (field === "event") message.event = value;
    if (field === "id") message.id = value;
    if (field === "retry") message.retry = Number(value);
  }

  message.data = message.data.replace(/\n$/, "");
  return message.data || message.event || message.id ? message : null;
}

export async function* readSseMessages(response: Response): AsyncGenerator<SseMessage> {
  if (!response.body) throw new Error("Stream response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.match(/\r?\n\r?\n/);
      while (separator?.index !== undefined) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);

        const message = parseSseBlock(block);
        if (message) yield message;

        separator = buffer.match(/\r?\n\r?\n/);
      }
    }

    buffer += decoder.decode();
    const message = parseSseBlock(buffer);
    if (message) yield message;
  } finally {
    reader.releaseLock();
  }
}

export function parseSseData<T = unknown>(data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    return data as T;
  }
}

export interface StreamOptions {
  apiOrigin: string;
  jwt: string;
  apiToken: string;
  lastEventId?: string;
  signal?: AbortSignal;
}

export async function connectScoreStream(
  options: StreamOptions
): Promise<{ stream: AsyncGenerator<SseMessage>; response: Response }> {
  const url = `${options.apiOrigin}/api/scores/stream`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.jwt}`,
    "X-Api-Token": options.apiToken,
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (options.lastEventId) {
    headers["Last-Event-ID"] = options.lastEventId;
  }

  const response = await fetch(url, {
    headers,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Score stream failed: ${response.status} ${response.statusText}`);
  }

  return {
    stream: readSseMessages(response),
    response,
  };
}

export async function connectOddsStream(
  options: StreamOptions
): Promise<{ stream: AsyncGenerator<SseMessage>; response: Response }> {
  const url = `${options.apiOrigin}/api/odds/stream`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.jwt}`,
    "X-Api-Token": options.apiToken,
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (options.lastEventId) {
    headers["Last-Event-ID"] = options.lastEventId;
  }

  const response = await fetch(url, {
    headers,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Odds stream failed: ${response.status} ${response.statusText}`);
  }

  return {
    stream: readSseMessages(response),
    response,
  };
}
