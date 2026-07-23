import {
  deriveTwinState,
  facingFromServo,
  normalizeAzimuth,
  panelBasisFromFacing,
  shortestAngularDelta,
  sphericalToUnitVector
} from "./digital-twin-core.js";
import {
  bilinearAdc,
  brightnessFromAdc,
  normalizeReadings,
  thermalColor
} from "./heatmap-core.js";

const byId = (id) => document.getElementById(id);
const MIN_SUN_LOCK_BRIGHTNESS = 4000;

const heatStage = byId("heatStage");
const heatCanvas = byId("heatCanvas");
const heatContext = heatCanvas.getContext("2d", { alpha: false });
const twinStage = byId("twinStage");
const twinCanvas = byId("twinCanvas");
const twinContext = twinCanvas.getContext("2d");
const connectionStatus = byId("connectionStatus");
const liveToggle = byId("liveToggle");

const valueElements = [
  byId("valueTL"),
  byId("valueTR"),
  byId("valueBL"),
  byId("valueBR")
];

const display = {
  directionStatus: byId("directionStatus"),
  servoStatus: byId("servoStatus"),
  sunAzimuth: byId("sunAzimuth"),
  sunElevation: byId("sunElevation"),
  sunState: byId("sunState"),
  sunGaugeMarker: byId("sunGaugeMarker"),
  panelAzimuth: byId("panelAzimuth"),
  panelElevation: byId("panelElevation"),
  panValue: byId("panValue"),
  tiltValue: byId("tiltValue"),
  panTrack: byId("panTrack"),
  tiltTrack: byId("tiltTrack"),
  horizontalError: byId("horizontalError"),
  verticalError: byId("verticalError"),
  totalLight: byId("totalLight"),
  brightestCorner: byId("brightestCorner"),
  balanceState: byId("balanceState"),
  azimuthError: byId("azimuthError"),
  elevationError: byId("elevationError"),
  angularError: byId("angularError"),
  errorOrbitPanel: byId("errorOrbitPanel"),
  calibrationStatus: byId("calibrationStatus"),
  facingMode: byId("facingMode"),
  dataAge: byId("dataAge"),
  entryId: byId("entryId"),
  twinHealth: byId("twinHealth"),
  directionArrow: byId("directionArrow"),
  footerTimestamp: byId("footerTimestamp")
};

let readings = [4095, 4095, 4095, 4095];
let lastEntryId = null;
let lastTelemetry = null;
let lastTwinState = null;
let pollTimer = null;
let polling = false;
let calibration = null;

const model = {
  pan: 90,
  tilt: 90,
  sunAzimuth: 180,
  sunElevation: 20,
  hasSun: false,
  hasPose: false
};

const targetModel = { ...model };

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatDegrees(value, digits = 1) {
  return Number.isFinite(value) ? `${formatNumber(value, digits)}°` : "—";
}

function formatSignedDegrees(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, digits)}°`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "TIME UNAVAILABLE";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).toUpperCase();
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "AGE UNKNOWN";
  if (ageMs < 1000) return "LIVE / NOW";
  if (ageMs < 60_000) return `LIVE / ${Math.floor(ageMs / 1000)}s OLD`;
  return `STALE / ${Math.floor(ageMs / 60_000)}m OLD`;
}

function colorWithAlpha(color, alpha) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function drawHeatmap() {
  const bounds = heatStage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  heatCanvas.width = Math.round(bounds.width * pixelRatio);
  heatCanvas.height = Math.round(bounds.height * pixelRatio);

  const gridWidth = 160;
  const gridHeight = Math.max(
    80,
    Math.round(gridWidth * bounds.height / bounds.width)
  );
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
  heatContext.imageSmoothingEnabled = true;
  heatContext.drawImage(
    buffer,
    0,
    0,
    heatCanvas.width,
    heatCanvas.height
  );
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
  const drawingScale = Math.min(width / 12.2, height / 8.4);
  return {
    x: width * 0.49 + (point.x * 0.84 - point.z * 0.59) * drawingScale,
    y:
      height * 0.72 +
      (point.x * 0.29 + point.z * 0.34 - point.y) * drawingScale
  };
}

function strokeWorldLine(context, first, second, width, height, options = {}) {
  const start = project(first, width, height);
  const end = project(second, width, height);
  context.save();
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.strokeStyle = options.color || "rgba(117, 238, 229, 0.38)";
  context.lineWidth = options.lineWidth || 1;
  context.globalAlpha = options.alpha ?? 1;
  if (options.dash) context.setLineDash(options.dash);
  context.stroke();
  context.restore();
  return { start, end };
}

function strokeWorldPolyline(context, points, width, height, options = {}) {
  if (points.length < 2) return;
  context.save();
  context.beginPath();
  points.forEach((point, index) => {
    const projected = project(point, width, height);
    if (index === 0) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
  });
  if (options.closed) context.closePath();
  context.strokeStyle = options.color || "rgba(117, 238, 229, 0.38)";
  context.lineWidth = options.lineWidth || 1;
  context.globalAlpha = options.alpha ?? 1;
  if (options.dash) context.setLineDash(options.dash);
  context.stroke();
  context.restore();
}

function fillWorldPolygon(context, points, width, height, fill, stroke) {
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

function drawArrow(context, start, vector, length, width, height, options = {}) {
  const endpoint = add(start, scale(vector, length));
  const projected = strokeWorldLine(
    context,
    start,
    endpoint,
    width,
    height,
    options
  );
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
  context.fillStyle = options.color || "#75eee5";
  context.fill();
  context.restore();

  return { ...projected, endpoint };
}

function drawWorldLabel(context, text, point, width, height, color, alignment) {
  const projected = project(point, width, height);
  context.save();
  context.font = `${Math.max(9, width / 105)}px "DM Mono", monospace`;
  context.fillStyle = color;
  context.textAlign = alignment || "left";
  context.fillText(text, projected.x, projected.y);
  context.restore();
}

function drawGround(context, width, height) {
  for (let coordinate = -5; coordinate <= 5; coordinate += 1) {
    const major = coordinate === 0;
    const options = {
      color: major
        ? "rgba(117, 238, 229, 0.24)"
        : "rgba(117, 238, 229, 0.075)",
      lineWidth: major ? 1.15 : 0.75
    };
    strokeWorldLine(
      context,
      vec(coordinate, 0, -5),
      vec(coordinate, 0, 5),
      width,
      height,
      options
    );
    strokeWorldLine(
      context,
      vec(-5, 0, coordinate),
      vec(5, 0, coordinate),
      width,
      height,
      options
    );
  }

  drawWorldLabel(context, "NORTH", vec(0, 0, 5.25), width, height, "#75eee5", "center");
  drawWorldLabel(context, "WEST", vec(5.25, 0, 0), width, height, "#75eee5", "left");
}

function drawBase(context, width, height) {
  const bottom = [
    vec(-0.92, 0, -0.68),
    vec(0.92, 0, -0.68),
    vec(0.92, 0, 0.68),
    vec(-0.92, 0, 0.68)
  ];
  const top = bottom.map((point) => add(point, vec(0, 0.36, 0)));

  fillWorldPolygon(
    context,
    top,
    width,
    height,
    "rgba(27, 91, 96, 0.16)",
    "rgba(117, 238, 229, 0.42)"
  );

  bottom.forEach((point, index) => {
    strokeWorldLine(context, point, top[index], width, height, {
      color: "rgba(117, 238, 229, 0.32)"
    });
  });
  strokeWorldPolyline(context, bottom, width, height, {
    closed: true,
    color: "rgba(117, 238, 229, 0.22)"
  });

  const panRing = [];
  for (let index = 0; index <= 48; index += 1) {
    const angle = (index / 48) * Math.PI * 2;
    panRing.push(vec(Math.cos(angle) * 0.61, 0.45, Math.sin(angle) * 0.61));
  }
  strokeWorldPolyline(context, panRing, width, height, {
    color: "rgba(117, 238, 229, 0.65)",
    lineWidth: 1.2
  });

  strokeWorldLine(context, vec(0, 0.45, 0), vec(0, 2.72, 0), width, height, {
    color: "rgba(210, 246, 242, 0.6)",
    lineWidth: 2
  });
  strokeWorldLine(context, vec(-0.1, 0.45, 0), vec(-0.1, 2.72, 0), width, height, {
    color: "rgba(117, 238, 229, 0.16)"
  });
}

function panelPoint(center, basis, horizontal, vertical) {
  return add(
    center,
    add(scale(basis.right, horizontal), scale(basis.up, vertical))
  );
}

function drawPanel(context, facing, width, height) {
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
      const sample = bilinearAdc(
        readings,
        (x0 + x1) / 2,
        (y0 + y1) / 2
      );
      const brightness = brightnessFromAdc(sample);
      const color = thermalColor(brightness);
      const points = [
        panelPoint(center, basis, left, top),
        panelPoint(center, basis, right, top),
        panelPoint(center, basis, right, bottom),
        panelPoint(center, basis, left, bottom)
      ];
      fillWorldPolygon(
        context,
        points,
        width,
        height,
        colorWithAlpha(color, 0.045 + brightness * 0.13),
        "rgba(117, 238, 229, 0.17)"
      );
    }
  }

  const corners = [
    panelPoint(center, basis, -panelWidth / 2, panelHeight / 2),
    panelPoint(center, basis, panelWidth / 2, panelHeight / 2),
    panelPoint(center, basis, panelWidth / 2, -panelHeight / 2),
    panelPoint(center, basis, -panelWidth / 2, -panelHeight / 2)
  ];
  strokeWorldPolyline(context, corners, width, height, {
    closed: true,
    color: "rgba(175, 255, 247, 0.82)",
    lineWidth: 1.6
  });

  strokeWorldLine(
    context,
    panelPoint(center, basis, -2.25, 0),
    panelPoint(center, basis, 2.25, 0),
    width,
    height,
    { color: "rgba(255, 255, 255, 0.6)", lineWidth: 1.5 }
  );

  const cornerReadings = [readings[0], readings[1], readings[3], readings[2]];
  corners.forEach((corner, index) => {
    const projected = project(corner, width, height);
    const color = thermalColor(brightnessFromAdc(cornerReadings[index]));
    context.save();
    context.beginPath();
    context.arc(projected.x, projected.y, 4.2, 0, Math.PI * 2);
    context.fillStyle = colorWithAlpha(color, 0.96);
    context.shadowBlur = 12;
    context.shadowColor = colorWithAlpha(color, 0.9);
    context.fill();
    context.restore();
  });

  const normalArrow = drawArrow(
    context,
    center,
    basis.normal,
    2.25,
    width,
    height,
    {
      color: "#75eee5",
      lineWidth: 1.7,
      arrowSize: 9
    }
  );
  context.save();
  context.fillStyle = "#75eee5";
  context.font = `${Math.max(9, width / 105)}px "DM Mono", monospace`;
  context.fillText(
    "PANEL FACING",
    normalArrow.end.x + 8,
    normalArrow.end.y - 7
  );
  context.restore();

  return center;
}

function drawSunVector(context, center, sun, width, height) {
  if (!sun) return;
  const arrow = drawArrow(context, center, sun.vector, 3.45, width, height, {
    color: "#ffc247",
    lineWidth: 1.7,
    dash: [7, 5],
    arrowSize: 10
  });

  context.save();
  context.beginPath();
  context.arc(arrow.end.x, arrow.end.y, 7, 0, Math.PI * 2);
  context.fillStyle = "#ffc247";
  context.shadowBlur = 22;
  context.shadowColor = "#ff9a2f";
  context.fill();
  context.font = `${Math.max(9, width / 105)}px "DM Mono", monospace`;
  context.fillStyle = "#ffc247";
  context.fillText(
    `SUN ${Math.round(sun.azimuthDeg)}° / ${Math.round(sun.elevationDeg)}°`,
    arrow.end.x + 12,
    arrow.end.y + 4
  );
  context.restore();
}

function drawPanArc(context, azimuth, width, height) {
  const points = [];
  const steps = 36;
  const radians = (azimuth * Math.PI) / 180;
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * radians;
    points.push(vec(Math.sin(angle) * 1.12, 0.49, Math.cos(angle) * 1.12));
  }
  strokeWorldPolyline(context, points, width, height, {
    color: "rgba(255, 194, 71, 0.58)",
    lineWidth: 1.15
  });
}

function currentFacing() {
  if (!model.hasPose) return null;
  const relative = facingFromServo(model.pan, model.tilt);
  if (!relative) return null;
  const azimuthDeg = normalizeAzimuth(
    relative.azimuthDeg + (calibration?.azimuthOffsetDeg || 0)
  );
  const elevationDeg = clamp(
    relative.elevationDeg + (calibration?.elevationOffsetDeg || 0),
    -90,
    90
  );
  return {
    ...relative,
    azimuthDeg,
    elevationDeg,
    vector: sphericalToUnitVector(azimuthDeg, elevationDeg)
  };
}

function drawTwin() {
  const bounds = twinStage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(bounds.width * pixelRatio);
  const pixelHeight = Math.round(bounds.height * pixelRatio);

  if (twinCanvas.width !== pixelWidth || twinCanvas.height !== pixelHeight) {
    twinCanvas.width = pixelWidth;
    twinCanvas.height = pixelHeight;
  }

  twinContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  twinContext.clearRect(0, 0, bounds.width, bounds.height);

  drawGround(twinContext, bounds.width, bounds.height);
  drawBase(twinContext, bounds.width, bounds.height);

  const facing = currentFacing();
  if (!facing) return;
  drawPanArc(twinContext, facing.azimuthDeg, bounds.width, bounds.height);
  const panelCenter = drawPanel(
    twinContext,
    facing,
    bounds.width,
    bounds.height
  );

  if (model.hasSun) {
    drawSunVector(
      twinContext,
      panelCenter,
      {
        azimuthDeg: model.sunAzimuth,
        elevationDeg: model.sunElevation,
        vector: sphericalToUnitVector(model.sunAzimuth, model.sunElevation)
      },
      bounds.width,
      bounds.height
    );
  }

  twinCanvas.setAttribute(
    "aria-label",
    `Wireframe solar tracker. Pan ${model.pan.toFixed(1)} degrees, tilt ${model.tilt.toFixed(1)} degrees. Panel facing ${facing.azimuthDeg.toFixed(1)} degrees azimuth and ${facing.elevationDeg.toFixed(1)} degrees elevation.`
  );
}

function interpolateAngle(current, target, amount) {
  const delta = shortestAngularDelta(current, target);
  return normalizeAzimuth(current + delta * amount);
}

function animateTwin() {
  const response = 0.075;
  model.pan += (targetModel.pan - model.pan) * response;
  model.tilt += (targetModel.tilt - model.tilt) * response;
  model.sunAzimuth = interpolateAngle(
    model.sunAzimuth,
    targetModel.sunAzimuth,
    response
  );
  model.sunElevation +=
    (targetModel.sunElevation - model.sunElevation) * response;
  model.hasSun = targetModel.hasSun;
  model.hasPose = targetModel.hasPose;
  drawTwin();
  window.requestAnimationFrame(animateTwin);
}

function attemptSunCalibration(twin) {
  if (
    calibration ||
    !twin.balanced ||
    !twin.facing ||
    twin.facing.atZenith ||
    !twin.sun.valid ||
    !twin.sun.aboveHorizon ||
    twin.health.status !== "live" ||
    twin.totalLight < MIN_SUN_LOCK_BRIGHTNESS
  ) {
    return;
  }

  calibration = {
    azimuthOffsetDeg: shortestAngularDelta(
      twin.facing.azimuthDeg,
      twin.sun.azimuthDeg
    ),
    elevationOffsetDeg:
      twin.sun.elevationDeg - twin.facing.elevationDeg,
    capturedAt: Date.now()
  };
}

function calibratedFacing(twin) {
  if (!twin.facing) return null;
  if (!calibration) return twin.facing;

  const azimuthDeg = normalizeAzimuth(
    twin.facing.azimuthDeg + calibration.azimuthOffsetDeg
  );
  const elevationDeg = clamp(
    twin.facing.elevationDeg + calibration.elevationOffsetDeg,
    -90,
    90
  );
  return {
    ...twin.facing,
    azimuthDeg,
    elevationDeg,
    vector: sphericalToUnitVector(azimuthDeg, elevationDeg)
  };
}

function calculateAlignment(facing, sun) {
  if (!facing || !sun.valid) return null;
  const azimuthDeltaDeg = shortestAngularDelta(
    facing.azimuthDeg,
    sun.azimuthDeg
  );
  const elevationDeltaDeg = sun.elevationDeg - facing.elevationDeg;
  const dot =
    facing.vector.x * sun.vector.x +
    facing.vector.y * sun.vector.y +
    facing.vector.z * sun.vector.z;
  return {
    azimuthDeltaDeg,
    elevationDeltaDeg,
    angularSeparationDeg:
      (Math.acos(clamp(dot, -1, 1)) * 180) / Math.PI
  };
}

function updateDirectionArrow(twin) {
  const horizontal = twin.horizontalError;
  const vertical = twin.verticalError;
  const magnitude = Math.hypot(horizontal, vertical);
  const arrow = display.directionArrow.querySelector("span");

  if (twin.balanced || magnitude < 1) {
    arrow.style.opacity = "0.22";
    arrow.style.transform = "translateY(-50%) scaleX(.45)";
    return;
  }

  const angle = (Math.atan2(-vertical, horizontal) * 180) / Math.PI;
  const length = clamp(magnitude / 500, 0.55, 1.15);
  arrow.style.opacity = "1";
  arrow.style.transform =
    `translateY(-50%) rotate(${angle}deg) scaleX(${length})`;
}

function updateHealth(twin) {
  display.dataAge.textContent = formatAge(twin.health.ageMs);
  display.twinHealth.textContent = twin.health.status.toUpperCase();
  display.twinHealth.style.color =
    twin.health.status === "live"
      ? "var(--lime)"
      : twin.health.status === "stale"
        ? "var(--danger)"
        : "var(--sun)";

  if (!polling) {
    connectionStatus.dataset.state = "paused";
    connectionStatus.textContent = "Telemetry paused";
    return;
  }

  connectionStatus.dataset.state =
    twin.health.status === "stale" ? "error" : "live";
  connectionStatus.textContent =
    `${twin.health.status === "live" ? "Live" : twin.health.status} · ` +
    `entry ${lastTelemetry?.entryId ?? "—"} · ${formatAge(twin.health.ageMs)}`;
}

function updateTelemetry(telemetry) {
  readings = normalizeReadings(telemetry.readings);
  const twin = deriveTwinState(telemetry);
  attemptSunCalibration(twin);
  const facing = calibratedFacing(twin);
  const alignment = calibration
    ? calculateAlignment(facing, twin.sun)
    : null;

  lastTelemetry = telemetry;
  lastTwinState = twin;

  valueElements.forEach((element, index) => {
    element.textContent = Math.round(readings[index]);
  });

  display.directionStatus.textContent =
    twin.balanced
      ? `Balanced inside ±${twin.deadband} ADC`
      : `${twin.horizontalDirection} / ${twin.verticalDirection}`;
  display.horizontalError.textContent = formatNumber(twin.horizontalError);
  display.verticalError.textContent = formatNumber(twin.verticalError);
  display.totalLight.textContent = formatNumber(twin.totalLight);
  display.brightestCorner.textContent = twin.brightestCorner;
  display.entryId.textContent = telemetry.entryId ?? "—";

  display.balanceState.dataset.state =
    twin.health.status !== "live"
      ? "fault"
      : twin.balanced
        ? "balanced"
        : "correcting";
  display.balanceState.textContent =
    twin.health.status !== "live"
      ? twin.health.status.toUpperCase()
      : twin.balanced
        ? "BALANCED"
        : "CORRECTING";

  display.panValue.textContent = formatNumber(telemetry.pan);
  display.tiltValue.textContent = formatNumber(telemetry.tilt);
  display.panTrack.style.width = `${clamp((telemetry.pan / 180) * 100, 0, 100)}%`;
  display.tiltTrack.style.width = `${clamp((telemetry.tilt / 180) * 100, 0, 100)}%`;
  display.servoStatus.textContent =
    `Commanded pose · pan ${formatDegrees(telemetry.pan, 0)} · ` +
    `tilt ${formatDegrees(telemetry.tilt, 0)}`;

  if (twin.sun.valid) {
    display.sunAzimuth.textContent = formatNumber(twin.sun.azimuthDeg, 1);
    display.sunElevation.textContent = formatNumber(twin.sun.elevationDeg, 1);
    display.sunState.textContent = twin.sun.aboveHorizon
      ? "Sun above horizon · NOAA estimate from ESP32 time and location"
      : "Sun below horizon · astronomical estimate only";
    display.sunGaugeMarker.style.left =
      `${clamp((twin.sun.elevationDeg / 90) * 100, 0, 100)}%`;
  } else {
    display.sunAzimuth.textContent = "—";
    display.sunElevation.textContent = "—";
    display.sunState.textContent = "Sun position unavailable";
    display.sunGaugeMarker.style.left = "0%";
  }

  if (facing) {
    display.panelAzimuth.textContent = formatNumber(facing.azimuthDeg, 1);
    display.panelElevation.textContent = formatNumber(facing.elevationDeg, 1);
  } else {
    display.panelAzimuth.textContent = "—";
    display.panelElevation.textContent = "—";
  }

  if (calibration) {
    display.facingMode.textContent = "ABSOLUTE / SUN-LOCKED";
    display.calibrationStatus.textContent =
      "Absolute frame calibrated automatically from a balanced LDR sun lock.";
  } else {
    display.facingMode.textContent = "RELATIVE / UNCALIBRATED";
    display.calibrationStatus.textContent =
      "Facing is relative to the base until a balanced sun lock calibrates north.";
  }

  if (alignment) {
    display.azimuthError.textContent = formatSignedDegrees(
      alignment.azimuthDeltaDeg
    );
    display.elevationError.textContent = formatSignedDegrees(
      alignment.elevationDeltaDeg
    );
    display.angularError.textContent = formatDegrees(
      alignment.angularSeparationDeg
    );
    const orbitOffset =
      clamp(alignment.azimuthDeltaDeg / 90, -1, 1) * 64;
    display.errorOrbitPanel.style.transform = `translateX(${orbitOffset}px)`;
  } else {
    display.azimuthError.textContent = "—";
    display.elevationError.textContent = "—";
    display.angularError.textContent = "—";
    display.errorOrbitPanel.style.transform = "translateX(-55px)";
  }

  updateDirectionArrow(twin);
  updateHealth(twin);

  targetModel.pan = Number.isFinite(telemetry.pan) ? telemetry.pan : model.pan;
  targetModel.tilt = Number.isFinite(telemetry.tilt)
    ? telemetry.tilt
    : model.tilt;
  targetModel.hasSun = twin.sun.valid;
  targetModel.hasPose = Boolean(twin.facing);
  if (twin.sun.valid) {
    targetModel.sunAzimuth = twin.sun.azimuthDeg;
    targetModel.sunElevation = twin.sun.elevationDeg;
  }

  heatCanvas.setAttribute(
    "aria-label",
    `Light heatmap. Top left ${readings[0]}, top right ${readings[1]}, ` +
    `bottom left ${readings[2]}, bottom right ${readings[3]}. ` +
    "Lower values are brighter."
  );
  display.footerTimestamp.textContent =
    `LAST MODEL UPDATE / ${formatTimestamp(telemetry.createdAt)}`;
  drawHeatmap();
}

function refreshSampleAge() {
  if (!lastTelemetry) return;
  try {
    const twin = deriveTwinState(lastTelemetry);
    lastTwinState = twin;
    updateHealth(twin);
  } catch (_error) {
    // A successfully parsed sample should remain valid. Keep the last UI if a
    // local clock or browser edge case prevents recalculating age.
  }
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
    } else if (lastTelemetry) {
      refreshSampleAge();
    }
  } catch (error) {
    connectionStatus.dataset.state = "error";
    connectionStatus.textContent = error.message;
    display.twinHealth.textContent = "LINK ERROR";
    display.twinHealth.style.color = "var(--danger)";
  }
}

function startPolling() {
  polling = true;
  liveToggle.innerHTML = '<span aria-hidden="true">Ⅱ</span> Pause feed';
  connectionStatus.dataset.state = "connecting";
  connectionStatus.textContent = "Connecting to ThingSpeak";
  pollLatest();
  pollTimer = window.setInterval(pollLatest, 5000);
}

function stopPolling() {
  polling = false;
  window.clearInterval(pollTimer);
  pollTimer = null;
  liveToggle.innerHTML = '<span aria-hidden="true">▶</span> Resume feed';
  connectionStatus.dataset.state = "paused";
  connectionStatus.textContent = "Telemetry paused";
}

liveToggle.addEventListener("click", () => {
  if (polling) stopPolling();
  else startPolling();
});

new ResizeObserver(drawHeatmap).observe(heatStage);
new ResizeObserver(drawTwin).observe(twinStage);
window.setInterval(refreshSampleAge, 1000);

drawHeatmap();
animateTwin();
startPolling();
