import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateLdrState,
  deriveTwinState,
  facingFromServo,
  isSunPositionValid,
  isTelemetryStale,
  normalizeAzimuth,
  panelBasisFromFacing,
  shortestAngularDelta,
  sunVector,
  telemetryAgeMs
} from "../digital-twin-core.js";

function assertNear(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test("LDR state matches the firmware equations and lower ADC is brighter", () => {
  const state = calculateLdrState([1000, 1100, 1300, 1500]);

  assert.equal(state.horizontalError, -150);
  assert.equal(state.verticalError, 350);
  assert.equal(state.totalLight, 11_480);
  assert.equal(state.balanced, false);
  assert.equal(state.horizontalDirection, "move left");
  assert.equal(state.verticalDirection, "move up");
  assert.equal(state.brightestCorner, "top left");
  assert.equal(state.brightestCornerKey, "topLeft");
  assert.equal(state.brightestAdc, 1000);
});

test("the default 30-count deadband is inclusive", () => {
  const atBoundary = calculateLdrState([1030, 1000, 1030, 1000]);
  const outsideBoundary = calculateLdrState([1031, 1000, 1031, 1000]);

  assert.equal(atBoundary.horizontalError, 30);
  assert.equal(atBoundary.balanced, true);
  assert.equal(atBoundary.horizontalDirection, "centered");
  assert.equal(outsideBoundary.horizontalError, 31);
  assert.equal(outsideBoundary.balanced, false);
  assert.equal(outsideBoundary.horizontalDirection, "move right");
});

test("ties use the existing TL, TR, BL, BR corner order", () => {
  const state = calculateLdrState([500, 500, 800, 900]);
  assert.equal(state.brightestIndex, 0);
  assert.equal(state.brightestCorner, "top left");
});

test("servo facing crosses zenith with an over-the-top azimuth flip", () => {
  const beforeZenith = facingFromServo(30, 60);
  const afterZenith = facingFromServo(30, 120);
  const zenith = facingFromServo(150, 90);

  assert.equal(beforeZenith.azimuthDeg, 30);
  assert.equal(beforeZenith.elevationDeg, 60);
  assert.equal(beforeZenith.overTheTop, false);
  assert.equal(afterZenith.azimuthDeg, 210);
  assert.equal(afterZenith.elevationDeg, 60);
  assert.equal(afterZenith.overTheTop, true);
  assert.equal(zenith.elevationDeg, 90);
  assert.equal(zenith.atZenith, true);

  for (const facing of [beforeZenith, afterZenith, zenith]) {
    const magnitude = Math.hypot(
      facing.vector.x,
      facing.vector.y,
      facing.vector.z
    );
    assertNear(magnitude, 1);
  }

  assert.equal(facingFromServo(-1, 90), null);
  assert.equal(facingFromServo(90, 181), null);
});

test("panel sensor corners remain continuous while tilt crosses zenith", () => {
  const before = panelBasisFromFacing(facingFromServo(30, 89.9));
  const after = panelBasisFromFacing(facingFromServo(30, 90.1));

  const rightDot =
    before.right.x * after.right.x +
    before.right.y * after.right.y +
    before.right.z * after.right.z;
  const upDot =
    before.up.x * after.up.x +
    before.up.y * after.up.y +
    before.up.z * after.up.z;

  assertNear(rightDot, 1);
  assert.ok(upDot > 0.999, "local panel up should not flip at zenith");

  for (const basis of [before, after]) {
    const normalRightDot =
      basis.normal.x * basis.right.x +
      basis.normal.y * basis.right.y +
      basis.normal.z * basis.right.z;
    const normalUpDot =
      basis.normal.x * basis.up.x +
      basis.normal.y * basis.up.y +
      basis.normal.z * basis.up.z;
    assertNear(normalRightDot, 0);
    assertNear(normalUpDot, 0);
  }
});

test("azimuth wrapping and shortest rotation handle north correctly", () => {
  assert.equal(normalizeAzimuth(-10), 350);
  assert.equal(normalizeAzimuth(370), 10);
  assert.equal(shortestAngularDelta(350, 10), 20);
  assert.equal(shortestAngularDelta(10, 350), -20);
  assert.equal(shortestAngularDelta(0, 180), -180);
});

test("sun helpers validate elevation and return a unit vector", () => {
  assert.equal(isSunPositionValid(370, 30), true);
  assert.equal(isSunPositionValid(10, -5), true);
  assert.equal(isSunPositionValid(10, 91), false);
  assert.equal(isSunPositionValid(null, 30), false);
  assert.equal(sunVector(20, 95), null);

  const vector = sunVector(90, 0);
  assertNear(vector.x, 1);
  assertNear(vector.y, 0);
  assertNear(vector.z, 0);
});

test("telemetry staleness is deterministic and future clock skew clamps to zero", () => {
  const createdAt = "2026-07-23T12:00:00.000Z";
  assert.equal(
    telemetryAgeMs(createdAt, "2026-07-23T12:00:45.000Z"),
    45_000
  );
  assert.equal(
    isTelemetryStale(createdAt, "2026-07-23T12:01:00.000Z", 60_000),
    false
  );
  assert.equal(
    isTelemetryStale(createdAt, "2026-07-23T12:01:00.001Z", 60_000),
    true
  );
  assert.equal(
    telemetryAgeMs(createdAt, "2026-07-23T11:59:00.000Z"),
    0
  );
  assert.equal(isTelemetryStale("", Date.now()), null);
});

test("deriveTwinState produces live pose, sun, alignment, and health state", () => {
  const state = deriveTwinState(
    {
      createdAt: "2026-07-23T12:00:00.000Z",
      readings: [1000, 1100, 1300, 1500],
      pan: 30,
      tilt: 120,
      sunAzimuth: 210,
      sunElevation: 60
    },
    {
      now: "2026-07-23T12:00:20.000Z"
    }
  );

  assert.equal(state.facing.azimuthDeg, 210);
  assert.equal(state.facing.elevationDeg, 60);
  assert.equal(state.sun.valid, true);
  assert.equal(state.sun.aboveHorizon, true);
  assert.equal(state.alignment.azimuthDeltaDeg, 0);
  assert.equal(state.alignment.elevationDeltaDeg, 0);
  assertNear(state.alignment.angularSeparationDeg, 0, 1e-6);
  assert.deepEqual(state.health, {
    status: "live",
    stale: false,
    ageMs: 20_000,
    issues: []
  });
});

test("deriveTwinState reports stale and partial samples without inventing pose data", () => {
  const stale = deriveTwinState(
    {
      createdAt: "2026-07-23T12:00:00.000Z",
      readings: [2000, 2000, 2000, 2000],
      pan: 90,
      tilt: 90,
      sunAzimuth: 180,
      sunElevation: -10
    },
    {
      now: "2026-07-23T12:02:00.000Z"
    }
  );
  assert.equal(stale.health.status, "stale");
  assert.equal(stale.health.stale, true);
  assert.equal(stale.sun.aboveHorizon, false);

  const partial = deriveTwinState({
    readings: [2000, 2000, 2000, 2000]
  });
  assert.equal(partial.facing, null);
  assert.equal(partial.sun.valid, false);
  assert.equal(partial.alignment, null);
  assert.equal(partial.health.status, "partial");
  assert.deepEqual(partial.health.issues, [
    "timestamp-unavailable",
    "servo-position-unavailable",
    "sun-position-unavailable"
  ]);
});

test("deriveTwinState rejects samples without four numeric LDR readings", () => {
  assert.throws(
    () => deriveTwinState({ readings: [100, 200, 300] }),
    /must contain/
  );
  assert.throws(
    () => deriveTwinState({ readings: [100, 200, null, 400] }),
    /must be numeric/
  );
});
