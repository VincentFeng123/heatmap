import {
  analyzeReadings,
  bilinearAdc,
  brightnessFromAdc,
  normalizeReadings,
  thermalColor
} from "./heatmap-core.js";

const stage = document.getElementById("heatStage");
const canvas = document.getElementById("heatCanvas");
const context = canvas.getContext("2d", { alpha: false });
const connectionStatus = document.getElementById("connectionStatus");
const directionStatus = document.getElementById("directionStatus");
const servoStatus = document.getElementById("servoStatus");
const liveToggle = document.getElementById("liveToggle");
const valueElements = [
  document.getElementById("valueTL"),
  document.getElementById("valueTR"),
  document.getElementById("valueBL"),
  document.getElementById("valueBR")
];

let readings = [4095, 4095, 4095, 4095];
let lastEntryId = null;
let pollTimer = null;
let polling = false;

function drawHeatmap() {
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * pixelRatio);
  canvas.height = Math.round(bounds.height * pixelRatio);

  const gridWidth = 160;
  const gridHeight = Math.max(80, Math.round(gridWidth * bounds.height / bounds.width));
  const buffer = document.createElement("canvas");
  buffer.width = gridWidth;
  buffer.height = gridHeight;
  const bufferContext = buffer.getContext("2d");
  const image = bufferContext.createImageData(gridWidth, gridHeight);

  for (let y = 0; y < gridHeight; y += 1) {
    const vertical = y / (gridHeight - 1);
    for (let x = 0; x < gridWidth; x += 1) {
      const horizontal = x / (gridWidth - 1);
      const sample = bilinearAdc(readings, horizontal, vertical);
      const color = thermalColor(brightnessFromAdc(sample));
      const offset = (y * gridWidth + x) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = 255;
    }
  }

  bufferContext.putImageData(image, 0, 0);
  context.imageSmoothingEnabled = true;
  context.drawImage(buffer, 0, 0, canvas.width, canvas.height);
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function updateTelemetry(telemetry) {
  readings = normalizeReadings(telemetry.readings);
  const analysis = analyzeReadings(readings);

  valueElements.forEach((element, index) => {
    element.textContent = Math.round(readings[index]);
  });

  directionStatus.textContent =
    `Brightest: ${analysis.brightestCorner} · ${analysis.horizontal} · ${analysis.vertical}`;

  const pan = Number.isFinite(telemetry.pan) ? `${telemetry.pan}°` : "—";
  const tilt = Number.isFinite(telemetry.tilt) ? `${telemetry.tilt}°` : "—";
  servoStatus.textContent = `Pan ${pan} · Tilt ${tilt}`;

  connectionStatus.dataset.state = "live";
  connectionStatus.textContent =
    `Live · entry ${telemetry.entryId} · ${formatTimestamp(telemetry.createdAt)}`;

  canvas.setAttribute(
    "aria-label",
    `Light heatmap. Top left ${readings[0]}, top right ${readings[1]}, bottom left ${readings[2]}, bottom right ${readings[3]}. Lower values are brighter.`
  );
  drawHeatmap();
}

async function pollLatest() {
  if (!polling) return;

  try {
    const response = await fetch("/api/latest", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Data request failed");

    if (payload.entryId !== lastEntryId) {
      lastEntryId = payload.entryId;
      updateTelemetry(payload);
    } else {
      connectionStatus.dataset.state = "live";
      connectionStatus.textContent =
        `Live · entry ${payload.entryId} · ${formatTimestamp(payload.createdAt)}`;
    }
  } catch (error) {
    connectionStatus.dataset.state = "error";
    connectionStatus.textContent = error.message;
  }
}

function startPolling() {
  polling = true;
  liveToggle.textContent = "Pause live";
  connectionStatus.dataset.state = "connecting";
  connectionStatus.textContent = "Connecting to ThingSpeak";
  pollLatest();
  pollTimer = window.setInterval(pollLatest, 5000);
}

function stopPolling() {
  polling = false;
  window.clearInterval(pollTimer);
  pollTimer = null;
  liveToggle.textContent = "Resume live";
  connectionStatus.dataset.state = "paused";
  connectionStatus.textContent = "Paused";
}

liveToggle.addEventListener("click", () => {
  if (polling) stopPolling();
  else startPolling();
});

new ResizeObserver(drawHeatmap).observe(stage);
drawHeatmap();
startPolling();
