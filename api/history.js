import {
  buildThingSpeakHistoryUrl,
  parseThingSpeakHistory
} from "../lib/thingspeak.js";
import { DEFAULT_CHANNEL_ID } from "./latest.js";

export const DEFAULT_HISTORY_RESULTS = 120;

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store, max-age=0");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const channelId = process.env.THINGSPEAK_CHANNEL_ID || DEFAULT_CHANNEL_ID;
  const readApiKey = process.env.THINGSPEAK_READ_API_KEY || "";

  let url;
  try {
    url = buildThingSpeakHistoryUrl(
      channelId,
      readApiKey,
      request.query?.results || DEFAULT_HISTORY_RESULTS
    );
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 8000);

  try {
    const upstream = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: abortController.signal
    });

    if (!upstream.ok) {
      return response.status(502).json({
        error: `ThingSpeak returned HTTP ${upstream.status}`
      });
    }

    const payload = JSON.parse(await upstream.text());
    const entries = parseThingSpeakHistory(payload);
    return response.status(200).json({ entries });
  } catch (_error) {
    return response.status(502).json({
      error: "Unable to retrieve ThingSpeak history"
    });
  } finally {
    clearTimeout(timeout);
  }
}
