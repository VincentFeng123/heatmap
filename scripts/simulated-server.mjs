import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.PORT || 4173);
const startedAt = Date.now();

const simulatedEntries = [
  {
    readings: [420, 1850, 2960, 3520],
    pan: 72,
    tilt: 58,
    sunAzimuth: 106.4,
    sunElevation: 29.8
  },
  {
    readings: [3200, 510, 3420, 2140],
    pan: 101,
    tilt: 62,
    sunAzimuth: 132.7,
    sunElevation: 47.3
  },
  {
    readings: [3380, 2810, 460, 2050],
    pan: 84,
    tilt: 109,
    sunAzimuth: 175.2,
    sunElevation: 65.1
  },
  {
    readings: [3470, 3010, 2210, 390],
    pan: 118,
    tilt: 104,
    sunAzimuth: 221.6,
    sunElevation: 50.4
  },
  {
    readings: [1920, 1950, 1980, 1940],
    pan: 90,
    tilt: 60,
    sunAzimuth: 252.9,
    sunElevation: 30.6
  }
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function interpolateValue(first, second, amount) {
  return first + (second - first) * amount;
}

function simulatedHistory(count = 80) {
  const now = Date.now();
  return Array.from({ length: count }, (_unused, index) => {
    const position =
      (index / Math.max(1, count - 1)) * (simulatedEntries.length - 1);
    const firstIndex = Math.floor(position);
    const secondIndex = Math.min(firstIndex + 1, simulatedEntries.length - 1);
    const amount = position - firstIndex;
    const first = simulatedEntries[firstIndex];
    const second = simulatedEntries[secondIndex];
    return {
      entryId: 1000 + index,
      createdAt: new Date(now - (count - 1 - index) * 20_000).toISOString(),
      readings: first.readings.map((value, readingIndex) =>
        Math.round(
          interpolateValue(value, second.readings[readingIndex], amount)
        )
      ),
      pan: Math.round(interpolateValue(first.pan, second.pan, amount)),
      tilt: Math.round(interpolateValue(first.tilt, second.tilt, amount)),
      sunAzimuth: interpolateValue(
        first.sunAzimuth,
        second.sunAzimuth,
        amount
      ),
      sunElevation: interpolateValue(
        first.sunElevation,
        second.sunElevation,
        amount
      )
    };
  });
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (requestUrl.pathname === "/api/history") {
    const requestedResults = Number(requestUrl.searchParams.get("results"));
    const count = Number.isFinite(requestedResults)
      ? Math.max(2, Math.min(240, Math.round(requestedResults)))
      : 80;
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify({ entries: simulatedHistory(count) }));
    return;
  }

  if (requestUrl.pathname === "/api/latest") {
    const index = Math.floor((Date.now() - startedAt) / 5000) % simulatedEntries.length;
    const entry = simulatedEntries[index];
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify({
      entryId: index + 1,
      createdAt: new Date().toISOString(),
      ...entry
    }));
    return;
  }

  const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = normalize(join(root, requestedPath));
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  } catch (_error) {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Simulated heatmap: http://127.0.0.1:${port}`);
});
