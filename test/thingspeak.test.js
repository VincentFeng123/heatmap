import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CHANNEL_ID } from "../api/latest.js";
import {
  buildThingSpeakUrl,
  parseThingSpeakFeed
} from "../lib/thingspeak.js";

const simulatedFeed = {
  created_at: "2026-07-21T17:00:00Z",
  entry_id: 42,
  field1: "420",
  field2: "1730",
  field3: "2875",
  field4: "3520",
  field5: "96",
  field6: "48",
  field7: "236.42",
  field8: "34.75"
};

test("the deployed heatmap defaults to channel 3432834", () => {
  assert.equal(DEFAULT_CHANNEL_ID, "3432834");
});

test("a simulated ThingSpeak row maps all sensor, servo, and sun values", () => {
  assert.deepEqual(parseThingSpeakFeed(simulatedFeed), {
    entryId: 42,
    createdAt: "2026-07-21T17:00:00Z",
    readings: [420, 1730, 2875, 3520],
    pan: 96,
    tilt: 48,
    sunAzimuth: 236.42,
    sunElevation: 34.75
  });
});

test("older feeds without sun telemetry preserve nullable sun values", () => {
  const { field7: _field7, field8: _field8, ...feedWithoutSun } = simulatedFeed;

  assert.deepEqual(parseThingSpeakFeed(feedWithoutSun), {
    entryId: 42,
    createdAt: "2026-07-21T17:00:00Z",
    readings: [420, 1730, 2875, 3520],
    pan: 96,
    tilt: 48,
    sunAzimuth: null,
    sunElevation: null
  });
});

test("invalid optional sun telemetry is treated as unavailable", () => {
  const parsed = parseThingSpeakFeed({
    ...simulatedFeed,
    field7: "not-a-number",
    field8: ""
  });

  assert.equal(parsed.sunAzimuth, null);
  assert.equal(parsed.sunElevation, null);
});

test("the private read key stays in the server-side ThingSpeak request", () => {
  const url = buildThingSpeakUrl("3432834", "private-read-key");
  assert.equal(url.hostname, "api.thingspeak.com");
  assert.equal(url.pathname, "/channels/3432834/feeds/last.json");
  assert.equal(url.searchParams.get("api_key"), "private-read-key");
});

test("public channels omit the read key", () => {
  const url = buildThingSpeakUrl(3432834);
  assert.equal(url.search, "");
});

test("incomplete sensor rows are rejected", () => {
  assert.throws(
    () => parseThingSpeakFeed({ ...simulatedFeed, field3: null }),
    /field3 is missing/
  );
});
