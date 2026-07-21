import { buildThingSpeakUrl, parseThingSpeakFeed } from "../lib/thingspeak.js";

export const DEFAULT_CHANNEL_ID = "3432834";

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
    url = buildThingSpeakUrl(channelId, readApiKey);
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

    const text = (await upstream.text()).trim();
    if (text === "-1") {
      return response.status(503).json({
        error: "No readable ThingSpeak entry. Check the Read API key or wait for the first ESP32 upload."
      });
    }

    const telemetry = parseThingSpeakFeed(JSON.parse(text));
    return response.status(200).json(telemetry);
  } catch (_error) {
    return response.status(502).json({
      error: "Unable to retrieve ThingSpeak data"
    });
  } finally {
    clearTimeout(timeout);
  }
}
