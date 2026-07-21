import assert from "node:assert/strict";
import test from "node:test";

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
  field6: "48"
};

test("a simulated ThingSpeak row maps to four LDR and two servo values", () => {
  assert.deepEqual(parseThingSpeakFeed(simulatedFeed), {
    entryId: 42,
    createdAt: "2026-07-21T17:00:00Z",
    readings: [420, 1730, 2875, 3520],
    pan: 96,
    tilt: 48
  });
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
