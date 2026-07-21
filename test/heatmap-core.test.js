import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeReadings,
  bilinearAdc,
  brightnessFromAdc,
  normalizeReadings,
  thermalColor
} from "../heatmap-core.js";

test("lower ADC values are brighter", () => {
  assert.equal(brightnessFromAdc(0), 1);
  assert.equal(brightnessFromAdc(4095), 0);
  assert.ok(brightnessFromAdc(500) > brightnessFromAdc(3000));
});

test("bilinear interpolation preserves all four sensor corners", () => {
  const values = [400, 1400, 2600, 3600];
  assert.equal(bilinearAdc(values, 0, 0), 400);
  assert.equal(bilinearAdc(values, 1, 0), 1400);
  assert.equal(bilinearAdc(values, 0, 1), 2600);
  assert.equal(bilinearAdc(values, 1, 1), 3600);
  assert.equal(bilinearAdc(values, 0.5, 0.5), 2000);
});

test("direction analysis points toward the lowest ADC corner", () => {
  const result = analyzeReadings([400, 2000, 3000, 3600]);
  assert.equal(result.brightestCorner, "top left");
  assert.equal(result.horizontal, "move left");
  assert.equal(result.vertical, "move up");
});

test("balanced readings stay centered", () => {
  const result = analyzeReadings([2000, 2040, 1980, 2010]);
  assert.equal(result.horizontal, "centered");
  assert.equal(result.vertical, "centered");
});

test("input and output values are bounded", () => {
  assert.deepEqual(normalizeReadings([-20, 100, 5000, "2000"]), [0, 100, 4095, 2000]);
  for (const color of [thermalColor(0), thermalColor(0.5), thermalColor(1)]) {
    assert.equal(color.length, 3);
    assert.ok(color.every(channel => channel >= 0 && channel <= 255));
  }
});
