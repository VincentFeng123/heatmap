export const ADC_MAX = 4095;
export const DEFAULT_DEADBAND = 30;
export const DEFAULT_STALE_AFTER_MS = 60_000;

const CORNERS = [
  { key: "topLeft", label: "top left" },
  { key: "topRight", label: "top right" },
  { key: "bottomLeft", label: "bottom left" },
  { key: "bottomRight", label: "bottom right" }
];

const DEGREES_TO_RADIANS = Math.PI / 180;
const VECTOR_EPSILON = 1e-12;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timeInMilliseconds(value) {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const numeric = finiteNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function normalizedReadings(values) {
  if (!Array.isArray(values) || values.length !== 4) {
    throw new TypeError(
      "telemetry.readings must contain [top-left, top-right, bottom-left, bottom-right]"
    );
  }

  return values.map((value, index) => {
    const numeric = finiteNumber(value);
    if (numeric === null) {
      throw new TypeError(`LDR reading ${index + 1} must be numeric`);
    }
    return Math.round(clamp(numeric, 0, ADC_MAX));
  });
}

/**
 * Calculate the same four-LDR error terms used by the ESP32 firmware.
 * Positive horizontal error means the right side is brighter.
 * Positive vertical error means the top side is brighter.
 */
export function calculateLdrState(values, deadband = DEFAULT_DEADBAND) {
  const readings = normalizedReadings(values);
  const normalizedDeadband = Math.max(0, finiteNumber(deadband) ?? DEFAULT_DEADBAND);
  const [topLeft, topRight, bottomLeft, bottomRight] = readings;

  // Preserve the firmware's integer division behavior.
  const leftAdc = Math.trunc((topLeft + bottomLeft) / 2);
  const rightAdc = Math.trunc((topRight + bottomRight) / 2);
  const topAdc = Math.trunc((topLeft + topRight) / 2);
  const bottomAdc = Math.trunc((bottomLeft + bottomRight) / 2);
  const horizontalError = leftAdc - rightAdc;
  const verticalError = bottomAdc - topAdc;
  const totalLight = readings.reduce(
    (sum, reading) => sum + ADC_MAX - reading,
    0
  );
  const brightestIndex = readings.indexOf(Math.min(...readings));

  return {
    readings,
    horizontalError,
    verticalError,
    totalLight,
    balanced:
      Math.abs(horizontalError) <= normalizedDeadband &&
      Math.abs(verticalError) <= normalizedDeadband,
    horizontalDirection:
      Math.abs(horizontalError) <= normalizedDeadband
        ? "centered"
        : horizontalError > 0
          ? "move right"
          : "move left",
    verticalDirection:
      Math.abs(verticalError) <= normalizedDeadband
        ? "centered"
        : verticalError > 0
          ? "move up"
          : "move down",
    brightestCorner: CORNERS[brightestIndex].label,
    brightestCornerKey: CORNERS[brightestIndex].key,
    brightestIndex,
    brightestAdc: readings[brightestIndex],
    deadband: normalizedDeadband
  };
}

export function normalizeAzimuth(angleDegrees) {
  const angle = finiteNumber(angleDegrees);
  if (angle === null) return null;
  return ((angle % 360) + 360) % 360;
}

/**
 * Convert azimuth/elevation to a unit vector.
 * Axes are x=east/right, y=up, z=north/forward.
 */
export function sphericalToUnitVector(azimuthDegrees, elevationDegrees) {
  const azimuth = finiteNumber(azimuthDegrees);
  const elevation = finiteNumber(elevationDegrees);
  if (azimuth === null || elevation === null) return null;

  const azimuthRadians = azimuth * DEGREES_TO_RADIANS;
  const elevationRadians = elevation * DEGREES_TO_RADIANS;
  const horizontalScale = Math.cos(elevationRadians);

  return {
    x: horizontalScale * Math.sin(azimuthRadians),
    y: Math.sin(elevationRadians),
    z: horizontalScale * Math.cos(azimuthRadians)
  };
}

/**
 * Map the stacked 0..180 degree pan/tilt commands to a relative panel normal.
 * Tilt 90 is zenith. After the panel crosses zenith, its azimuth flips 180
 * degrees and its elevation descends, which models an over-the-top movement.
 */
export function facingFromServo(panCommand, tiltCommand) {
  const pan = finiteNumber(panCommand);
  const tilt = finiteNumber(tiltCommand);
  if (
    pan === null ||
    tilt === null ||
    pan < 0 ||
    pan > 180 ||
    tilt < 0 ||
    tilt > 180
  ) {
    return null;
  }

  const overTheTop = tilt > 90;
  const azimuthDeg = normalizeAzimuth(pan + (overTheTop ? 180 : 0));
  const elevationDeg = 90 - Math.abs(tilt - 90);

  return {
    panCommandDeg: pan,
    tiltCommandDeg: tilt,
    azimuthDeg,
    elevationDeg,
    overTheTop,
    atZenith: Math.abs(tilt - 90) < VECTOR_EPSILON,
    vector: sphericalToUnitVector(azimuthDeg, elevationDeg)
  };
}

export function isSunPositionValid(azimuthDegrees, elevationDegrees) {
  const azimuth = finiteNumber(azimuthDegrees);
  const elevation = finiteNumber(elevationDegrees);
  return (
    azimuth !== null &&
    elevation !== null &&
    elevation >= -90 &&
    elevation <= 90
  );
}

export function sunVector(azimuthDegrees, elevationDegrees) {
  if (!isSunPositionValid(azimuthDegrees, elevationDegrees)) return null;
  return sphericalToUnitVector(
    normalizeAzimuth(azimuthDegrees),
    Number(elevationDegrees)
  );
}

/**
 * Signed target-minus-current rotation in the range [-180, 180).
 */
export function shortestAngularDelta(currentDegrees, targetDegrees) {
  const current = finiteNumber(currentDegrees);
  const target = finiteNumber(targetDegrees);
  if (current === null || target === null) return null;
  return ((target - current + 540) % 360) - 180;
}

export function telemetryAgeMs(createdAt, now = Date.now()) {
  const timestamp = timeInMilliseconds(createdAt);
  const currentTime = timeInMilliseconds(now);
  if (timestamp === null || currentTime === null) return null;
  return Math.max(0, currentTime - timestamp);
}

export function isTelemetryStale(
  createdAt,
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS
) {
  const ageMs = telemetryAgeMs(createdAt, now);
  const threshold = finiteNumber(staleAfterMs);
  if (ageMs === null || threshold === null || threshold < 0) return null;
  return ageMs > threshold;
}

function angularSeparationDegrees(first, second) {
  if (!first || !second) return null;
  const dot =
    first.x * second.x +
    first.y * second.y +
    first.z * second.z;
  return Math.acos(clamp(dot, -1, 1)) / DEGREES_TO_RADIANS;
}

/**
 * Recover the panel's local axes without letting its sensor-corner layout
 * rotate 180 degrees when the tilt servo passes over zenith.
 */
export function panelBasisFromFacing(facing) {
  if (!facing || typeof facing !== "object" || Array.isArray(facing)) {
    return null;
  }

  const vector = facing.vector;
  const x = finiteNumber(vector?.x);
  const y = finiteNumber(vector?.y);
  const z = finiteNumber(vector?.z);
  const azimuth = finiteNumber(facing.azimuthDeg);
  const magnitude = Math.hypot(x ?? 0, y ?? 0, z ?? 0);
  if (
    x === null ||
    y === null ||
    z === null ||
    azimuth === null ||
    magnitude < VECTOR_EPSILON
  ) {
    return null;
  }

  const normal = {
    x: x / magnitude,
    y: y / magnitude,
    z: z / magnitude
  };

  // The tilt hinge follows the pan axis. The normal flips its azimuth by 180°
  // after crossing zenith, but the hinge—and therefore local panel right—does
  // not. Removing that flip keeps TL/TR/BL/BR physically continuous.
  const hingeAzimuth = normalizeAzimuth(
    azimuth - (facing.overTheTop ? 180 : 0)
  );
  const hingeRadians = hingeAzimuth * DEGREES_TO_RADIANS;
  const right = {
    x: Math.cos(hingeRadians),
    y: 0,
    z: -Math.sin(hingeRadians)
  };
  const rawUp = {
    x: normal.y * right.z - normal.z * right.y,
    y: normal.z * right.x - normal.x * right.z,
    z: normal.x * right.y - normal.y * right.x
  };
  const upMagnitude = Math.hypot(rawUp.x, rawUp.y, rawUp.z);
  if (upMagnitude < VECTOR_EPSILON) return null;

  return {
    normal,
    right,
    up: {
      x: rawUp.x / upMagnitude,
      y: rawUp.y / upMagnitude,
      z: rawUp.z / upMagnitude
    }
  };
}

/**
 * Derive all display-ready digital-twin state from one telemetry sample.
 */
export function deriveTwinState(
  telemetry,
  {
    deadband = DEFAULT_DEADBAND,
    now = Date.now(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS
  } = {}
) {
  if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) {
    throw new TypeError("telemetry must be an object");
  }

  const light = calculateLdrState(telemetry.readings, deadband);
  const pan = firstFinite(telemetry.pan, telemetry.panCommand);
  const tilt = firstFinite(telemetry.tilt, telemetry.tiltCommand);
  const facing = facingFromServo(pan, tilt);

  const rawSunAzimuth = firstFinite(
    telemetry.sunAzimuth,
    telemetry.sunAzimuthDeg,
    telemetry.sun?.azimuth,
    telemetry.sun?.azimuthDeg
  );
  const rawSunElevation = firstFinite(
    telemetry.sunElevation,
    telemetry.sunElevationDeg,
    telemetry.sun?.elevation,
    telemetry.sun?.elevationDeg
  );
  const sunValid = isSunPositionValid(rawSunAzimuth, rawSunElevation);
  const sun = {
    valid: sunValid,
    aboveHorizon: sunValid ? rawSunElevation >= 0 : false,
    azimuthDeg: sunValid ? normalizeAzimuth(rawSunAzimuth) : null,
    elevationDeg: sunValid ? rawSunElevation : null,
    vector: sunValid ? sunVector(rawSunAzimuth, rawSunElevation) : null
  };

  const ageMs = telemetryAgeMs(telemetry.createdAt, now);
  const stale = isTelemetryStale(telemetry.createdAt, now, staleAfterMs);
  const issues = [];
  if (ageMs === null) issues.push("timestamp-unavailable");
  if (stale) issues.push("telemetry-stale");
  if (!facing) issues.push("servo-position-unavailable");
  if (!sun.valid) issues.push("sun-position-unavailable");

  let status = "live";
  if (stale) status = "stale";
  else if (issues.length > 0) status = "partial";

  const alignment =
    facing && sun.valid
      ? {
          azimuthDeltaDeg: shortestAngularDelta(
            facing.azimuthDeg,
            sun.azimuthDeg
          ),
          elevationDeltaDeg: sun.elevationDeg - facing.elevationDeg,
          angularSeparationDeg: angularSeparationDegrees(
            facing.vector,
            sun.vector
          )
        }
      : null;

  return {
    ...light,
    facing,
    sun,
    alignment,
    health: {
      status,
      stale,
      ageMs,
      issues
    }
  };
}
