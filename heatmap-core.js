export const ADC_MAX = 4095;

const CORNER_NAMES = ["top left", "top right", "bottom left", "bottom right"];

const THERMAL_STOPS = [
  [0.00, [45, 15, 105]],
  [0.18, [29, 72, 220]],
  [0.36, [0, 191, 255]],
  [0.52, [0, 225, 135]],
  [0.68, [208, 242, 38]],
  [0.80, [255, 213, 0]],
  [0.91, [255, 112, 0]],
  [1.00, [255, 28, 20]]
];

export function clampAdc(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(ADC_MAX, numeric));
}

export function normalizeReadings(values) {
  if (!Array.isArray(values) || values.length !== 4) {
    throw new TypeError("Four LDR readings are required");
  }
  return values.map(clampAdc);
}

export function brightnessFromAdc(value) {
  return 1 - clampAdc(value) / ADC_MAX;
}

export function voltageFromAdc(value, referenceVoltage = 3.3) {
  const numericReference = Number(referenceVoltage);
  const normalizedReference =
    Number.isFinite(numericReference) && numericReference >= 0
      ? numericReference
      : 3.3;
  return (clampAdc(value) / ADC_MAX) * normalizedReference;
}

export function bilinearAdc(values, horizontal, vertical) {
  const [topLeft, topRight, bottomLeft, bottomRight] = normalizeReadings(values);
  const x = Math.max(0, Math.min(1, Number(horizontal)));
  const y = Math.max(0, Math.min(1, Number(vertical)));
  const top = topLeft * (1 - x) + topRight * x;
  const bottom = bottomLeft * (1 - x) + bottomRight * x;
  return top * (1 - y) + bottom * y;
}

export function analyzeReadings(values, deadband = 80) {
  const readings = normalizeReadings(values);
  const brightestIndex = readings.indexOf(Math.min(...readings));
  const leftAdc = (readings[0] + readings[2]) / 2;
  const rightAdc = (readings[1] + readings[3]) / 2;
  const topAdc = (readings[0] + readings[1]) / 2;
  const bottomAdc = (readings[2] + readings[3]) / 2;

  return {
    readings,
    brightestIndex,
    brightestCorner: CORNER_NAMES[brightestIndex],
    horizontal:
      Math.abs(rightAdc - leftAdc) <= deadband
        ? "centered"
        : rightAdc < leftAdc
          ? "move right"
          : "move left",
    vertical:
      Math.abs(topAdc - bottomAdc) <= deadband
        ? "centered"
        : topAdc < bottomAdc
          ? "move up"
          : "move down"
  };
}

function mixColor(first, second, amount) {
  return first.map((channel, index) =>
    Math.round(channel + (second[index] - channel) * amount)
  );
}

export function thermalColor(normalizedBrightness) {
  const value = Math.max(0, Math.min(1, Number(normalizedBrightness) || 0));
  for (let index = 1; index < THERMAL_STOPS.length; index += 1) {
    if (value <= THERMAL_STOPS[index][0]) {
      const previous = THERMAL_STOPS[index - 1];
      const next = THERMAL_STOPS[index];
      const amount = (value - previous[0]) / (next[0] - previous[0]);
      return mixColor(previous[1], next[1], amount);
    }
  }
  return [...THERMAL_STOPS.at(-1)[1]];
}
