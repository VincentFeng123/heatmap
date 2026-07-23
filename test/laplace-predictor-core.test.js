import assert from "node:assert/strict";
import test from "node:test";

import {
  estimatePredictionHorizon,
  exactFirstOrderStep,
  predictTrackerTrajectory,
  predictionErrorDegrees,
  servoModelRegion
} from "../laplace-predictor-core.js";

function telemetry(overrides = {}) {
  return {
    createdAt: "2026-07-23T12:00:00.000Z",
    entryId: 1,
    readings: [2000, 2000, 2000, 2000],
    pan: 90,
    tilt: 60,
    sunAzimuth: 180,
    sunElevation: 45,
    ...overrides
  };
}

test("the exact first-order step matches the inverse Laplace response", () => {
  const response = exactFirstOrderStep(0, 100, 1, 1);
  assert.ok(Math.abs(response - 63.2120559) < 1e-6);
  assert.equal(exactFirstOrderStep(20, 80, 1, 0), 80);
});

test("prediction horizon follows the causal telemetry cadence", () => {
  const history = [
    telemetry({ createdAt: "2026-07-23T12:00:00.000Z" }),
    telemetry({ createdAt: "2026-07-23T12:00:18.000Z", entryId: 2 }),
    telemetry({ createdAt: "2026-07-23T12:00:38.000Z", entryId: 3 }),
    telemetry({ createdAt: "2026-07-23T12:00:58.000Z", entryId: 4 })
  ];
  assert.equal(estimatePredictionHorizon(history), 20);
  assert.equal(estimatePredictionHorizon(history.slice(0, 1)), 20);
});

test("servo regions preserve the stacked mount pan reversal band", () => {
  assert.equal(servoModelRegion(60), "below-axis");
  assert.equal(servoModelRegion(90), "axis-band");
  assert.equal(servoModelRegion(120), "above-axis");
});

test("balanced light produces a stationary causal forecast", () => {
  const current = telemetry();
  const forecast = predictTrackerTrajectory(current, [current], {
    horizonSeconds: 3
  });

  assert.ok(Math.abs(forecast.pan - 90) < 1e-9);
  assert.ok(Math.abs(forecast.tilt - 60) < 1e-9);
  assert.equal(forecast.lockedAtSeconds, 0);
  assert.equal(forecast.modelSource, "firmware-prior");
  assert.ok(forecast.trajectory.length > 2);
});

test("right-side light below the axis predicts increasing pan and lower error", () => {
  const current = telemetry({
    readings: [2200, 1800, 2200, 1800],
    pan: 90,
    tilt: 60
  });
  const forecast = predictTrackerTrajectory(current, [current], {
    horizonSeconds: 3
  });

  assert.ok(forecast.pan > current.pan);
  assert.ok(
    Math.abs(forecast.horizontalError) <
      Math.abs(2000 - 1600),
    `expected horizontal error to shrink, got ${forecast.horizontalError}`
  );
});

test("the same light error above the axis predicts reversed pan movement", () => {
  const current = telemetry({
    readings: [2200, 1800, 2200, 1800],
    pan: 90,
    tilt: 120
  });
  const forecast = predictTrackerTrajectory(current, [current], {
    horizonSeconds: 3
  });

  assert.ok(forecast.pan < current.pan);
});

test("replay accuracy compares a forecast with the withheld next sample", () => {
  const current = telemetry();
  const forecast = predictTrackerTrajectory(current, [current], {
    horizonSeconds: 3
  });
  assert.equal(
    predictionErrorDegrees(
      forecast,
      telemetry({ entryId: 2, pan: 93, tilt: 64 })
    ),
    5
  );
  assert.equal(predictionErrorDegrees(forecast, null), null);
});
