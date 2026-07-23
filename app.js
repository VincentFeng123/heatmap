import {
  facingFromServo,
  panelBasisFromFacing,
  shortestAngularDelta,
  sphericalToUnitVector
} from "./digital-twin-core.js";
import {
  bilinearAdc,
  brightnessFromAdc,
  normalizeReadings,
  voltageFromAdc
} from "./heatmap-core.js";

const views = [
  {
    name: "Perspective",
    mode: "perspective",
    stage: document.getElementById("perspectiveStage"),
    canvas: document.getElementById("perspectiveCanvas")
  },
  {
    name: "Top",
    mode: "top",
    stage: document.getElementById("topStage"),
    canvas: document.getElementById("topCanvas")
  },
  {
    name: "Side",
    mode: "side",
    stage: document.getElementById("sideStage"),
    canvas: document.getElementById("sideCanvas")
  }
].map((view) => ({
  ...view,
  context: view.canvas.getContext("2d")
}));
let context = views[0].context;
let projectionMode = views[0].mode;
const connection = document.querySelector(".connection");
const connectionStatus = document.getElementById("connectionStatus");
const liveToggle = document.getElementById("liveToggle");
const playbackToggle = document.getElementById("playbackToggle");
const timelineSlider = document.getElementById("timelineSlider");
const timelineTime = document.getElementById("timelineTime");
const timelineLive = document.getElementById("timelineLive");
const data = {
  pan: document.getElementById("panValue"),
  tilt: document.getElementById("tiltValue"),
  sunAzimuth: document.getElementById("sunAzimuth"),
  sunElevation: document.getElementById("sunElevation"),
  lightAverage: document.getElementById("lightAverage"),
  estimatedVoltage: document.getElementById("estimatedVoltage"),
  predictedPan: document.getElementById("predictedPan"),
  predictedTilt: document.getElementById("predictedTilt")
};

let readings = [1920, 1950, 1980, 1940];
let lastEntryId = null;
let lastPose = null;
let pollTimer = null;
let polling = true;
let historyEntries = [];
let historyIndex = -1;
let playbackTimer = null;
let playbackPlaying = false;
let followingLive = true;

const model = {
  pan: 90,
  tilt: 60,
  sunAzimuth: 145,
  sunElevation: 35,
  hasSun: true
};

const target = { ...model };
const prediction = {
  pan: 108,
  tilt: 52
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatDegrees(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}°` : "—";
}

function updateData() {
  const lightAverage =
    readings.reduce((sum, value) => sum + value, 0) / readings.length;
  data.pan.textContent = formatDegrees(target.pan);
  data.tilt.textContent = formatDegrees(target.tilt);
  data.sunAzimuth.textContent = target.hasSun
    ? formatDegrees(target.sunAzimuth)
    : "—";
  data.sunElevation.textContent = target.hasSun
    ? formatDegrees(target.sunElevation)
    : "—";
  data.lightAverage.textContent = Math.round(lightAverage).toLocaleString();
  data.estimatedVoltage.textContent =
    `${voltageFromAdc(lightAverage).toFixed(2)} V`;
  data.predictedPan.textContent = formatDegrees(prediction.pan);
  data.predictedTilt.textContent = formatDegrees(prediction.tilt);
}

function entryTimestamp(entry) {
  const timestamp = Date.parse(entry?.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatTimelineDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      seconds
    ).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateTimeline() {
  const lastIndex = Math.max(0, historyEntries.length - 1);
  const selectedIndex = clamp(historyIndex, 0, lastIndex);
  timelineSlider.max = String(lastIndex);
  timelineSlider.value = String(selectedIndex);
  timelineSlider.disabled = historyEntries.length < 2;
  const progress =
    lastIndex > 0 ? (selectedIndex / lastIndex) * 100 : 100;
  timelineSlider.style.setProperty(
    "--timeline-progress",
    `${progress.toFixed(2)}%`
  );
  timelineSlider.setAttribute(
    "aria-valuetext",
    historyEntries.length
      ? `${selectedIndex + 1} of ${historyEntries.length}`
      : "No movement history"
  );

  if (historyEntries.length) {
    const start = entryTimestamp(historyEntries[0]);
    const selected = entryTimestamp(historyEntries[selectedIndex]);
    const end = entryTimestamp(historyEntries[lastIndex]);
    const elapsed =
      start !== null && selected !== null
        ? selected - start
        : selectedIndex * 20_000;
    const duration =
      start !== null && end !== null
        ? end - start
        : lastIndex * 20_000;
    timelineTime.textContent =
      `${formatTimelineDuration(elapsed)} / ` +
      formatTimelineDuration(duration);
  } else {
    timelineTime.textContent = "0:00 / 0:00";
  }

  const atLiveEdge =
    followingLive &&
    historyEntries.length > 0 &&
    selectedIndex === lastIndex;
  timelineLive.dataset.live = String(atLiveEdge);
}

function setTelemetryView(telemetry, nextTelemetry = null) {
  readings = normalizeReadings(telemetry.readings);
  if (Number.isFinite(telemetry.pan)) target.pan = telemetry.pan;
  if (Number.isFinite(telemetry.tilt)) target.tilt = telemetry.tilt;

  const hasSun =
    Number.isFinite(telemetry.sunAzimuth) &&
    Number.isFinite(telemetry.sunElevation);
  target.hasSun = hasSun;
  if (hasSun) {
    target.sunAzimuth = telemetry.sunAzimuth;
    target.sunElevation = telemetry.sunElevation;
  }

  if (nextTelemetry) {
    prediction.pan = Number.isFinite(nextTelemetry.pan)
      ? nextTelemetry.pan
      : target.pan;
    prediction.tilt = Number.isFinite(nextTelemetry.tilt)
      ? nextTelemetry.tilt
      : target.tilt;
  }

  updateData();
}

function snapModelToTarget() {
  model.pan = target.pan;
  model.tilt = target.tilt;
  model.hasSun = target.hasSun;
  if (target.hasSun) {
    model.sunAzimuth = target.sunAzimuth;
    model.sunElevation = target.sunElevation;
  }
}

function selectHistoryIndex(index, snap = false) {
  if (!historyEntries.length) return;
  const lastIndex = historyEntries.length - 1;
  historyIndex = Math.round(clamp(index, 0, lastIndex));
  followingLive = historyIndex === lastIndex;
  const telemetry = historyEntries[historyIndex];
  const nextTelemetry =
    historyEntries[Math.min(historyIndex + 1, lastIndex)];
  setTelemetryView(telemetry, nextTelemetry);
  if (snap) snapModelToTarget();
  updateTimeline();
}

function stopHistoryPlayback() {
  playbackPlaying = false;
  window.clearInterval(playbackTimer);
  playbackTimer = null;
  playbackToggle.textContent = "▶";
  playbackToggle.setAttribute("aria-label", "Play movement history");
}

function startHistoryPlayback() {
  if (historyEntries.length < 2) return;
  if (historyIndex >= historyEntries.length - 1) {
    selectHistoryIndex(0, true);
  }
  playbackPlaying = true;
  followingLive = false;
  playbackToggle.textContent = "Ⅱ";
  playbackToggle.setAttribute("aria-label", "Pause movement history");
  updateTimeline();
  playbackTimer = window.setInterval(() => {
    if (historyIndex >= historyEntries.length - 1) {
      stopHistoryPlayback();
      followingLive = true;
      updateTimeline();
      return;
    }
    selectHistoryIndex(historyIndex + 1);
  }, 500);
}

function upsertHistoryEntry(telemetry) {
  const entryId = String(telemetry.entryId);
  const existingIndex = historyEntries.findIndex(
    (entry) => String(entry.entryId) === entryId
  );
  if (existingIndex >= 0) historyEntries[existingIndex] = telemetry;
  else historyEntries.push(telemetry);

  historyEntries.sort((first, second) => {
    const firstTime = entryTimestamp(first) ?? 0;
    const secondTime = entryTimestamp(second) ?? 0;
    return firstTime - secondTime;
  });

  if (historyEntries.length > 240) {
    const removed = historyEntries.length - 240;
    historyEntries.splice(0, removed);
    historyIndex = Math.max(0, historyIndex - removed);
  }

  return historyEntries.findIndex(
    (entry) => String(entry.entryId) === entryId
  );
}

async function loadHistory() {
  try {
    const response = await fetch("/api/history?results=120", {
      cache: "no-store"
    });
    if (!response.ok) throw new Error("History unavailable");
    const payload = await response.json();
    if (!Array.isArray(payload.entries)) {
      throw new Error("History unavailable");
    }

    const entriesById = new Map();
    payload.entries.forEach((entry) => {
      if (entry && Array.isArray(entry.readings) && entry.readings.length === 4) {
        entriesById.set(String(entry.entryId), entry);
      }
    });
    historyEntries = [...entriesById.values()].sort((first, second) => {
      const firstTime = entryTimestamp(first) ?? 0;
      const secondTime = entryTimestamp(second) ?? 0;
      return firstTime - secondTime;
    });

    if (historyEntries.length) {
      selectHistoryIndex(historyEntries.length - 1, true);
    } else {
      updateTimeline();
    }
  } catch (_error) {
    updateTimeline();
  }
}

function vec(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function add(first, second) {
  return vec(
    first.x + second.x,
    first.y + second.y,
    first.z + second.z
  );
}

function scale(vector, amount) {
  return vec(vector.x * amount, vector.y * amount, vector.z * amount);
}

function project(point, width, height) {
  if (projectionMode === "top") {
    const drawingScale = Math.min(width / 8.8, height / 8.8);
    return {
      x: width * 0.5 + point.x * drawingScale,
      y: height * 0.5 - point.z * drawingScale
    };
  }

  if (projectionMode === "side") {
    const drawingScale = Math.min(width / 10, height / 5.7);
    return {
      x: width * 0.5 + point.z * drawingScale,
      y: height * 0.93 - point.y * drawingScale
    };
  }

  const drawingScale = Math.min(width / 12.2, height / 8.4);
  return {
    x: width * 0.5 + (point.x * 0.84 - point.z * 0.59) * drawingScale,
    y:
      height * 0.7 +
      (point.x * 0.29 + point.z * 0.34 - point.y) * drawingScale
  };
}

function strokeWorldLine(first, second, width, height, options = {}) {
  const start = project(first, width, height);
  const end = project(second, width, height);

  context.save();
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.strokeStyle = options.color || "rgba(255, 255, 255, 0.28)";
  context.lineWidth = options.lineWidth || 1;
  if (options.dash) context.setLineDash(options.dash);
  context.stroke();
  context.restore();

  return { start, end };
}

function strokeWorldPolyline(points, width, height, options = {}) {
  if (points.length < 2) return;

  context.save();
  context.beginPath();
  points.forEach((point, index) => {
    const projected = project(point, width, height);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  if (options.closed) context.closePath();
  context.strokeStyle = options.color || "rgba(255, 255, 255, 0.28)";
  context.lineWidth = options.lineWidth || 1;
  if (options.dash) context.setLineDash(options.dash);
  context.stroke();
  context.restore();
}

function fillWorldPolygon(points, width, height, fill, stroke) {
  context.save();
  context.beginPath();
  points.forEach((point, index) => {
    const projected = project(point, width, height);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = 1;
    context.stroke();
  }
  context.restore();
}

function drawArrow(start, vector, length, width, height, options = {}) {
  const endpoint = add(start, scale(vector, length));
  const projected = strokeWorldLine(start, endpoint, width, height, options);
  const angle = Math.atan2(
    projected.end.y - projected.start.y,
    projected.end.x - projected.start.x
  );
  const arrowSize = options.arrowSize || 8;

  context.save();
  context.translate(projected.end.x, projected.end.y);
  context.rotate(angle);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(-arrowSize, -arrowSize * 0.52);
  context.lineTo(-arrowSize * 0.72, 0);
  context.lineTo(-arrowSize, arrowSize * 0.52);
  context.closePath();
  context.fillStyle = options.color || "#f4f4ef";
  context.fill();
  context.restore();

  return projected;
}

function drawGround(width, height) {
  if (projectionMode === "side") {
    strokeWorldLine(vec(0, 0, -5), vec(0, 0, 5), width, height, {
      color: "rgba(255, 255, 255, 0.18)",
      lineWidth: 1.15
    });
    for (let coordinate = -5; coordinate <= 5; coordinate += 1) {
      strokeWorldLine(
        vec(0, 0, coordinate),
        vec(0, 0.1, coordinate),
        width,
        height,
        { color: "rgba(255, 255, 255, 0.1)" }
      );
    }
    return;
  }

  for (let coordinate = -5; coordinate <= 5; coordinate += 1) {
    const major = coordinate === 0;
    const options = {
      color: major
        ? "rgba(255, 255, 255, 0.18)"
        : "rgba(255, 255, 255, 0.055)",
      lineWidth: major ? 1.15 : 0.75
    };

    strokeWorldLine(
      vec(coordinate, 0, -5),
      vec(coordinate, 0, 5),
      width,
      height,
      options
    );
    strokeWorldLine(
      vec(-5, 0, coordinate),
      vec(5, 0, coordinate),
      width,
      height,
      options
    );
  }
}

function drawBase(width, height) {
  const bottom = [
    vec(-0.92, 0, -0.68),
    vec(0.92, 0, -0.68),
    vec(0.92, 0, 0.68),
    vec(-0.92, 0, 0.68)
  ];
  const top = bottom.map((point) => add(point, vec(0, 0.36, 0)));

  fillWorldPolygon(
    top,
    width,
    height,
    "rgba(255, 255, 255, 0.035)",
    "rgba(255, 255, 255, 0.28)"
  );

  bottom.forEach((point, index) => {
    strokeWorldLine(point, top[index], width, height, {
      color: "rgba(255, 255, 255, 0.22)"
    });
  });
  strokeWorldPolyline(bottom, width, height, {
    closed: true,
    color: "rgba(255, 255, 255, 0.14)"
  });

  const panRing = [];
  for (let index = 0; index <= 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    panRing.push(vec(Math.cos(angle) * 0.61, 0.45, Math.sin(angle) * 0.61));
  }
  strokeWorldPolyline(panRing, width, height, {
    color: "rgba(255, 255, 255, 0.48)",
    lineWidth: 1.2
  });

  strokeWorldLine(vec(0, 0.45, 0), vec(0, 2.72, 0), width, height, {
    color: "rgba(255, 255, 255, 0.55)",
    lineWidth: 2
  });
  strokeWorldLine(vec(-0.1, 0.45, 0), vec(-0.1, 2.72, 0), width, height, {
    color: "rgba(255, 255, 255, 0.1)"
  });
}

function panelPoint(center, basis, horizontal, vertical) {
  return add(
    center,
    add(scale(basis.right, horizontal), scale(basis.up, vertical))
  );
}

function lightColor(brightness, alpha) {
  const channel = Math.round(12 + clamp(brightness, 0, 1) * 232);
  return `rgba(${channel}, ${channel}, ${channel}, ${alpha})`;
}

function drawPanel(facing, width, height) {
  const center = vec(0, 2.76, 0);
  const basis = panelBasisFromFacing(facing);
  if (!basis) return center;

  const panelWidth = 3.95;
  const panelHeight = 2.35;
  const columns = 8;
  const rows = 5;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x0 = column / columns;
      const x1 = (column + 1) / columns;
      const y0 = row / rows;
      const y1 = (row + 1) / rows;
      const left = (x0 - 0.5) * panelWidth;
      const right = (x1 - 0.5) * panelWidth;
      const top = (0.5 - y0) * panelHeight;
      const bottom = (0.5 - y1) * panelHeight;
      const brightness = brightnessFromAdc(
        bilinearAdc(readings, (x0 + x1) / 2, (y0 + y1) / 2)
      );

      fillWorldPolygon(
        [
          panelPoint(center, basis, left, top),
          panelPoint(center, basis, right, top),
          panelPoint(center, basis, right, bottom),
          panelPoint(center, basis, left, bottom)
        ],
        width,
        height,
        lightColor(brightness, 0.045 + brightness * 0.13),
        "rgba(255, 255, 255, 0.12)"
      );
    }
  }

  const corners = [
    panelPoint(center, basis, -panelWidth / 2, panelHeight / 2),
    panelPoint(center, basis, panelWidth / 2, panelHeight / 2),
    panelPoint(center, basis, panelWidth / 2, -panelHeight / 2),
    panelPoint(center, basis, -panelWidth / 2, -panelHeight / 2)
  ];

  strokeWorldPolyline(corners, width, height, {
    closed: true,
    color: "rgba(255, 255, 255, 0.78)",
    lineWidth: 1.6
  });

  strokeWorldLine(
    panelPoint(center, basis, -2.25, 0),
    panelPoint(center, basis, 2.25, 0),
    width,
    height,
    { color: "rgba(255, 255, 255, 0.6)", lineWidth: 1.5 }
  );

  const cornerReadings = [readings[0], readings[1], readings[3], readings[2]];
  corners.forEach((corner, index) => {
    const projected = project(corner, width, height);
    const brightness = brightnessFromAdc(cornerReadings[index]);
    context.save();
    context.beginPath();
    context.arc(projected.x, projected.y, 4.2, 0, Math.PI * 2);
    context.fillStyle = lightColor(brightness, 0.96);
    context.shadowBlur = 12;
    context.shadowColor = lightColor(brightness, 0.9);
    context.fill();
    context.restore();
  });

  drawArrow(
    center,
    basis.normal,
    2.25,
    width,
    height,
    {
      color: "#f4f4ef",
      lineWidth: 1.7,
      arrowSize: 9
    }
  );

  return center;
}

function drawSunVector(center, width, height) {
  if (!model.hasSun) return;
  const vector = sphericalToUnitVector(
    model.sunAzimuth,
    model.sunElevation
  );
  const arrow = drawArrow(center, vector, 3.45, width, height, {
    color: "#a7a7a2",
    lineWidth: 1.7,
    dash: [7, 5],
    arrowSize: 10
  });

  context.save();
  context.beginPath();
  context.arc(arrow.end.x, arrow.end.y, 7, 0, Math.PI * 2);
  context.fillStyle = "#d8d8d2";
  context.shadowBlur = 12;
  context.shadowColor = "rgba(255, 255, 255, 0.38)";
  context.fill();
  context.restore();
}

function drawPredictedPath(width, height) {
  const center = vec(0, 2.76, 0);
  const path = [];
  const steps = 5;

  for (let index = 0; index <= steps; index += 1) {
    const amount = index / steps;
    const pan = model.pan + (prediction.pan - model.pan) * amount;
    const tilt = model.tilt + (prediction.tilt - model.tilt) * amount;
    const facing = facingFromServo(pan, tilt);
    const basis = panelBasisFromFacing(facing);
    if (!basis) continue;

    path.push(add(center, scale(basis.normal, 2.25)));

    if (index === 0) continue;
    const opacity = 0.035 + amount * 0.1;
    const panelWidth = 3.95;
    const panelHeight = 2.35;
    const corners = [
      panelPoint(center, basis, -panelWidth / 2, panelHeight / 2),
      panelPoint(center, basis, panelWidth / 2, panelHeight / 2),
      panelPoint(center, basis, panelWidth / 2, -panelHeight / 2),
      panelPoint(center, basis, -panelWidth / 2, -panelHeight / 2)
    ];

    strokeWorldPolyline(corners, width, height, {
      closed: true,
      color: `rgba(255, 255, 255, ${opacity})`,
      lineWidth: 0.8,
      dash: [4, 5]
    });
  }

  if (path.length < 2) return;
  context.save();
  context.beginPath();
  path.forEach((point, index) => {
    const projected = project(point, width, height);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  context.strokeStyle = "rgba(255, 255, 255, 0.38)";
  context.lineWidth = 1.2;
  context.lineCap = "round";
  context.setLineDash([2, 7]);
  context.stroke();
  context.setLineDash([]);

  path.slice(1).forEach((point, index) => {
    const projected = project(point, width, height);
    context.beginPath();
    context.arc(projected.x, projected.y, index === path.length - 2 ? 3 : 2, 0, Math.PI * 2);
    context.fillStyle =
      index === path.length - 2
        ? "rgba(255, 255, 255, 0.72)"
        : "rgba(255, 255, 255, 0.32)";
    context.fill();
  });
  context.restore();
}

function drawPanArc(azimuth, width, height) {
  const points = [];
  const radians = (azimuth * Math.PI) / 180;

  for (let index = 0; index <= 36; index += 1) {
    const angle = (index / 36) * radians;
    points.push(vec(Math.sin(angle) * 1.12, 0.49, Math.cos(angle) * 1.12));
  }

  strokeWorldPolyline(points, width, height, {
    color: "rgba(255, 255, 255, 0.38)",
    lineWidth: 1.15
  });
}

function drawTwin(view) {
  const { stage, canvas } = view;
  context = view.context;
  projectionMode = view.mode;
  const bounds = stage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const pixelWidth = Math.round(bounds.width);
  const pixelHeight = Math.round(bounds.height);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);

  drawGround(bounds.width, bounds.height);
  drawBase(bounds.width, bounds.height);

  const facing = facingFromServo(model.pan, model.tilt);
  if (!facing) return;

  drawPredictedPath(bounds.width, bounds.height);
  drawPanArc(facing.azimuthDeg, bounds.width, bounds.height);
  const panelCenter = drawPanel(facing, bounds.width, bounds.height);
  drawSunVector(panelCenter, bounds.width, bounds.height);

  canvas.setAttribute(
    "aria-label",
    `${view.name} wireframe of the COSMOS solar tracker at pan ${model.pan.toFixed(
      1
    )} degrees and tilt ${model.tilt.toFixed(
      1
    )} degrees, with a predicted path toward pan ${prediction.pan.toFixed(
      1
    )} degrees and tilt ${prediction.tilt.toFixed(1)} degrees`
  );
}

function interpolateAngle(current, next, amount) {
  return current + shortestAngularDelta(current, next) * amount;
}

function animate() {
  const response = 0.075;
  model.pan += (target.pan - model.pan) * response;
  model.tilt += (target.tilt - model.tilt) * response;
  model.sunAzimuth = interpolateAngle(
    model.sunAzimuth,
    target.sunAzimuth,
    response
  );
  model.sunElevation +=
    (target.sunElevation - model.sunElevation) * response;
  model.hasSun = target.hasSun;

  views.forEach(drawTwin);
  window.requestAnimationFrame(animate);
}

async function pollLatest() {
  if (!polling) return;

  try {
    const response = await fetch("/api/latest", { cache: "no-store" });
    if (!response.ok) throw new Error("Telemetry unavailable");
    const telemetry = await response.json();
    connection.dataset.state = "live";
    connectionStatus.textContent = "Connected";
    if (telemetry.entryId === lastEntryId) return;
    lastEntryId = telemetry.entryId;

    const nextPan = Number.isFinite(telemetry.pan)
      ? telemetry.pan
      : target.pan;
    const nextTilt = Number.isFinite(telemetry.tilt)
      ? telemetry.tilt
      : target.tilt;

    let projectedPan = nextPan;
    let projectedTilt = nextTilt;
    if (lastPose) {
      const panStep = clamp(nextPan - lastPose.pan, -24, 24);
      const tiltStep = clamp(nextTilt - lastPose.tilt, -24, 24);
      projectedPan = clamp(nextPan + panStep * 1.5, 0, 180);
      projectedTilt = clamp(nextTilt + tiltStep * 1.5, 0, 180);
    } else {
      projectedPan = clamp(nextPan + 18, 0, 180);
      projectedTilt = clamp(nextTilt - 8, 0, 180);
    }

    lastPose = { pan: nextPan, tilt: nextTilt };
    const liveIndex = upsertHistoryEntry(telemetry);

    if (followingLive) {
      historyIndex = liveIndex;
      prediction.pan = projectedPan;
      prediction.tilt = projectedTilt;
      setTelemetryView(telemetry);
    }

    updateTimeline();
  } catch (_error) {
    connection.dataset.state = "offline";
    connectionStatus.textContent = "Offline";
  }
}

function setPolling(nextPolling) {
  polling = nextPolling;
  window.clearInterval(pollTimer);
  pollTimer = null;

  if (polling) {
    connection.dataset.state = "live";
    connectionStatus.textContent = "Connecting";
    liveToggle.textContent = "Pause";
    pollLatest();
    pollTimer = window.setInterval(pollLatest, 5000);
  } else {
    connection.dataset.state = "paused";
    connectionStatus.textContent = "Paused";
    liveToggle.textContent = "Resume";
  }
}

liveToggle.addEventListener("click", () => {
  setPolling(!polling);
});

playbackToggle.addEventListener("click", () => {
  if (playbackPlaying) stopHistoryPlayback();
  else startHistoryPlayback();
});

timelineSlider.addEventListener("input", () => {
  stopHistoryPlayback();
  selectHistoryIndex(Number(timelineSlider.value), true);
});

timelineLive.addEventListener("click", () => {
  stopHistoryPlayback();
  if (historyEntries.length) {
    selectHistoryIndex(historyEntries.length - 1, true);
  }
});

views.forEach((view) => {
  new ResizeObserver(() => drawTwin(view)).observe(view.stage);
});
updateData();
updateTimeline();
animate();
loadHistory().finally(() => setPolling(true));
