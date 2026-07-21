function numericField(feed, fieldName, required = true) {
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
  return Math.round(value);
}

export function buildThingSpeakUrl(channelId, readApiKey = "") {
  const normalizedChannelId = String(channelId ?? "").trim();
  if (!/^\d+$/.test(normalizedChannelId)) {
    throw new Error("THINGSPEAK_CHANNEL_ID must contain only digits");
  }

  const url = new URL(
    `https://api.thingspeak.com/channels/${normalizedChannelId}/feeds/last.json`
  );
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
    tilt: numericField(feed, "field6", false)
  };
}
