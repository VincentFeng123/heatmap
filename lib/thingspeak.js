function numericField(feed, fieldName, required = true, round = true) {
  const rawValue = feed[fieldName];
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (required) throw new Error(`${fieldName} is missing`);
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    if (required) throw new Error(`${fieldName} is not numeric`);
    return null;
  }
  return round ? Math.round(value) : value;
}

function normalizeChannelId(channelId) {
  const normalizedChannelId = String(channelId ?? "").trim();
  if (!/^\d+$/.test(normalizedChannelId)) {
    throw new Error("THINGSPEAK_CHANNEL_ID must contain only digits");
  }
  return normalizedChannelId;
}

export function buildThingSpeakUrl(channelId, readApiKey = "") {
  const normalizedChannelId = normalizeChannelId(channelId);
  const url = new URL(
    `https://api.thingspeak.com/channels/${normalizedChannelId}/feeds/last.json`
  );
  if (readApiKey) url.searchParams.set("api_key", readApiKey);
  return url;
}

export function buildThingSpeakHistoryUrl(
  channelId,
  readApiKey = "",
  results = 120
) {
  const normalizedChannelId = normalizeChannelId(channelId);
  const numericResults = Number(results);
  const normalizedResults = Number.isFinite(numericResults)
    ? Math.max(1, Math.min(8000, Math.round(numericResults)))
    : 120;
  const url = new URL(
    `https://api.thingspeak.com/channels/${normalizedChannelId}/feeds.json`
  );
  url.searchParams.set("results", String(normalizedResults));
  if (readApiKey) url.searchParams.set("api_key", readApiKey);
  return url;
}

export function parseThingSpeakFeed(feed) {
  if (!feed || typeof feed !== "object" || Array.isArray(feed)) {
    throw new Error("ThingSpeak returned no readable feed");
  }

  return {
    entryId: numericField(feed, "entry_id"),
    createdAt: String(feed.created_at || ""),
    readings: [
      numericField(feed, "field1"),
      numericField(feed, "field2"),
      numericField(feed, "field3"),
      numericField(feed, "field4")
    ],
    pan: numericField(feed, "field5", false),
    tilt: numericField(feed, "field6", false),
    sunAzimuth: numericField(feed, "field7", false, false),
    sunElevation: numericField(feed, "field8", false, false)
  };
}

export function parseThingSpeakHistory(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ThingSpeak returned no readable history");
  }
  if (!Array.isArray(payload.feeds)) {
    throw new Error("ThingSpeak history is missing feeds");
  }
  return payload.feeds.map(parseThingSpeakFeed);
}
