import { calculateLdrState } from "./digital-twin-core.js";

export const DEFAULT_PREDICTOR_CONFIG = Object.freeze({
  adcMaximum: 4095,
  commandMinimum: 0,
  commandMaximum: 180,
  controllerPeriodSeconds: 0.32,
  deadbandAdc: 30,
  ldrTimeConstantSeconds: 0.08,
  movementPenalty: 0.75,
  normalizedErrorScale: 2000,
  panTimeConstantSeconds: 0.35,
  predictionHorizonSeconds: 20,
  responseDelaySeconds: 0.12,
  simulationStepSeconds: 0.04,
  tiltTimeConstantSeconds: 0.45,
  trajectorySampleSeconds: 0.4
});

const LOWER_REGION = "below-axis";
const UPPER_REGION = "above-axis";
const CENTER_REGION = "axis-band";
const EPSILON = 1e-9;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mergedConfig(overrides = {}) {
  return { ...DEFAULT_PREDICTOR_CONFIG, ...overrides };
}

function telemetryTimestamp(telemetry) {
  const timestamp = Date.parse(telemetry?.createdAt || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validTelemetry(telemetry) {
  return (
    telemetry &&
    Array.isArray(telemetry.readings) &&
    telemetry.readings.length === 4 &&
    telemetry.readings.every((value) => finiteNumber(value) !== null) &&
    finiteNumber(telemetry.pan) !== null &&
    finiteNumber(telemetry.tilt) !== null
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function exactFirstOrderStep(
  current,
  target,
  elapsedSeconds,
  timeConstantSeconds
) {
  const elapsed = Math.max(0, finiteNumber(elapsedSeconds) ?? 0);
  const timeConstant = finiteNumber(timeConstantSeconds);
  if (timeConstant === null || timeConstant <= EPSILON) return target;
  const decay = Math.exp(-elapsed / timeConstant);
  return target + (current - target) * decay;
}

export function estimatePredictionHorizon(
  history,
  fallbackSeconds = DEFAULT_PREDICTOR_CONFIG.predictionHorizonSeconds
) {
  if (!Array.isArray(history) || history.length < 2) return fallbackSeconds;
  const intervals = [];
  for (let index = Math.max(1, history.length - 16); index < history.length; index += 1) {
    const previous = telemetryTimestamp(history[index - 1]);
    const current = telemetryTimestamp(history[index]);
    if (previous === null || current === null) continue;
    const intervalSeconds = (current - previous) / 1000;
    if (intervalSeconds >= 1 && intervalSeconds <= 120) {
      intervals.push(intervalSeconds);
    }
  }
  return clamp(median(intervals) ?? fallbackSeconds, 2, 60);
}

export function servoModelRegion(tiltCommand) {
  const tilt = finiteNumber(tiltCommand);
  if (tilt === null) return CENTER_REGION;
  if (tilt < 85) return LOWER_REGION;
  if (tilt > 95) return UPPER_REGION;
  return CENTER_REGION;
}

function defaultJacobian(region) {
  return region === UPPER_REGION
    ? [[12, 0], [0, -12]]
    : [[-12, 0], [0, -12]];
}

function ldrObservation(telemetry, config) {
  if (!validTelemetry(telemetry)) return null;
  const ldr = calculateLdrState(telemetry.readings, config.deadbandAdc);
  if (ldr.totalLight <= 0) return null;
  const scale = config.normalizedErrorScale / ldr.totalLight;
  return {
    horizontal: clamp(ldr.horizontalError * scale, -1000, 1000),
    vertical: clamp(ldr.verticalError * scale, -1000, 1000),
    rawHorizontal: ldr.horizontalError,
    rawVertical: ldr.verticalError,
    brightness: ldr.totalLight
  };
}

function clampJacobian(matrix) {
  return matrix.map((row) =>
    row.map((value) => clamp(value, -80, 80))
  );
}

export function estimateLocalResponseModel(
  history,
  requestedRegion,
  options = {}
) {
  const config = mergedConfig(options);
  const region =
    requestedRegion === UPPER_REGION ? UPPER_REGION : LOWER_REGION;
  const prior = defaultJacobian(region);
  const ridge = 12;

  let a00 = ridge;
  let a01 = 0;
  let a11 = ridge;
  let b00 = ridge * prior[0][0];
  let b01 = ridge * prior[0][1];
  let b10 = ridge * prior[1][0];
  let b11 = ridge * prior[1][1];
  let sampleCount = 0;
  let panEnergy = 0;
  let tiltEnergy = 0;
  let crossEnergy = 0;

  const entries = Array.isArray(history) ? history.slice(-80) : [];
  for (let index = 1; index < entries.length; index += 1) {
    const before = entries[index - 1];
    const after = entries[index];
    if (!validTelemetry(before) || !validTelemetry(after)) continue;
    if (
      servoModelRegion(before.tilt) !== region ||
      servoModelRegion(after.tilt) !== region
    ) {
      continue;
    }

    const beforeObservation = ldrObservation(before, config);
    const afterObservation = ldrObservation(after, config);
    if (!beforeObservation || !afterObservation) continue;
    if (
      beforeObservation.brightness < 800 ||
      afterObservation.brightness < 800
    ) {
      continue;
    }

    const panChange = Number(after.pan) - Number(before.pan);
    const tiltChange = Number(after.tilt) - Number(before.tilt);
    const actionEnergy =
      panChange * panChange + tiltChange * tiltChange;
    if (
      actionEnergy < 0.5 ||
      Math.abs(panChange) > 45 ||
      Math.abs(tiltChange) > 45
    ) {
      continue;
    }

    const horizontalChange =
      afterObservation.horizontal - beforeObservation.horizontal;
    const verticalChange =
      afterObservation.vertical - beforeObservation.vertical;
    if (
      Math.abs(horizontalChange) > 1200 ||
      Math.abs(verticalChange) > 1200
    ) {
      continue;
    }

    const beforeTime = telemetryTimestamp(before);
    const afterTime = telemetryTimestamp(after);
    const intervalSeconds =
      beforeTime !== null && afterTime !== null
        ? Math.max(1, (afterTime - beforeTime) / 1000)
        : 20;
    const weight = clamp(20 / intervalSeconds, 0.2, 1);

    a00 += weight * panChange * panChange;
    a01 += weight * panChange * tiltChange;
    a11 += weight * tiltChange * tiltChange;
    b00 += weight * horizontalChange * panChange;
    b01 += weight * horizontalChange * tiltChange;
    b10 += weight * verticalChange * panChange;
    b11 += weight * verticalChange * tiltChange;
    panEnergy += weight * panChange * panChange;
    tiltEnergy += weight * tiltChange * tiltChange;
    crossEnergy += weight * panChange * tiltChange;
    sampleCount += 1;
  }

  const determinant = a00 * a11 - a01 * a01;
  let matrix = prior;
  if (determinant > EPSILON) {
    const inverse00 = a11 / determinant;
    const inverse01 = -a01 / determinant;
    const inverse11 = a00 / determinant;
    matrix = clampJacobian([
      [
        b00 * inverse00 + b01 * inverse01,
        b00 * inverse01 + b01 * inverse11
      ],
      [
        b10 * inverse00 + b11 * inverse01,
        b10 * inverse01 + b11 * inverse11
      ]
    ]);
  }

  const independentExcitation = Math.max(
    0,
    panEnergy * tiltEnergy - crossEnergy * crossEnergy
  );
  const observationScore = sampleCount / (sampleCount + 8);
  const excitationScore =
    independentExcitation / (independentExcitation + 1600);
  const confidence =
    sampleCount === 0
      ? 0.12
      : clamp(0.16 + 0.74 * observationScore * Math.sqrt(excitationScore), 0.16, 0.9);

  return {
    confidence,
    matrix,
    region,
    sampleCount,
    source: sampleCount >= 4 ? "history-fit" : "firmware-prior"
  };
}

function adaptiveStepForError(absoluteError, deadband) {
  if (absoluteError > 600) return 8;
  if (absoluteError > 300) return 6;
  if (absoluteError > 150) return 4;
  if (absoluteError > 70) return 2;
  if (absoluteError > deadband) return 1;
  return 0;
}

function predictedCost(
  matrix,
  horizontal,
  vertical,
  panChange,
  tiltChange,
  movementPenalty
) {
  const nextHorizontal =
    horizontal +
    matrix[0][0] * panChange +
    matrix[0][1] * tiltChange;
  const nextVertical =
    vertical +
    matrix[1][0] * panChange +
    matrix[1][1] * tiltChange;
  return (
    nextHorizontal * nextHorizontal +
    nextVertical * nextVertical +
    movementPenalty *
      (panChange * panChange + tiltChange * tiltChange)
  );
}

function selectControllerMovement(
  commandPan,
  commandTilt,
  horizontal,
  vertical,
  brightness,
  models,
  config
) {
  const rawScale = brightness / config.normalizedErrorScale;
  const rawHorizontal = horizontal * rawScale;
  const rawVertical = vertical * rawScale;
  const panStep = adaptiveStepForError(
    Math.abs(rawHorizontal),
    config.deadbandAdc
  );
  const tiltStep = adaptiveStepForError(
    Math.abs(rawVertical),
    config.deadbandAdc
  );
  const region = servoModelRegion(commandTilt);

  if (region === CENTER_REGION && panStep > 0) {
    const escapeDirection = commandTilt <= 90 ? -1 : 1;
    return {
      pan: 0,
      tilt: escapeDirection * Math.max(1, Math.min(6, 6 - Math.abs(commandTilt - 90)))
    };
  }

  const model = models[region] || models[LOWER_REGION];
  const panMagnitude =
    region === CENTER_REGION
      ? 0
      : panStep > 0
        ? panStep
        : Math.min(2, tiltStep);
  const tiltMagnitude =
    tiltStep > 0 ? tiltStep : Math.min(2, panStep);
  const panOptions = [-panMagnitude, 0, panMagnitude];
  const tiltOptions = [-tiltMagnitude, 0, tiltMagnitude];
  const currentCost = horizontal * horizontal + vertical * vertical;
  let bestCost = currentCost;
  let bestPan = 0;
  let bestTilt = 0;

  for (const panOption of panOptions) {
    for (const tiltOption of tiltOptions) {
      const nextPan = clamp(
        commandPan + panOption,
        config.commandMinimum,
        config.commandMaximum
      );
      const nextTilt = clamp(
        commandTilt + tiltOption,
        config.commandMinimum,
        config.commandMaximum
      );
      const actualPan = nextPan - commandPan;
      const actualTilt = nextTilt - commandTilt;
      if (actualPan === 0 && actualTilt === 0) continue;
      if (servoModelRegion(nextTilt) !== region) continue;

      const cost = predictedCost(
        model.matrix,
        horizontal,
        vertical,
        actualPan,
        actualTilt,
        config.movementPenalty
      );
      if (cost < bestCost) {
        bestCost = cost;
        bestPan = actualPan;
        bestTilt = actualTilt;
      }
    }
  }

  const requiredImprovement = Math.max(4, currentCost * 0.002);
  if (currentCost - bestCost >= requiredImprovement) {
    return { pan: bestPan, tilt: bestTilt };
  }

  const effectivePanDirection =
    region === LOWER_REGION ? 1 : region === UPPER_REGION ? -1 : 0;
  return {
    pan:
      panStep > 0
        ? Math.sign(rawHorizontal) * effectivePanDirection * panStep
        : 0,
    tilt:
      tiltStep > 0 ? Math.sign(rawVertical) * tiltStep : 0
  };
}

function modelForTilt(models, tilt) {
  const region = servoModelRegion(tilt);
  return models[region] || (
    tilt <= 90 ? models[LOWER_REGION] : models[UPPER_REGION]
  );
}

function appendTrajectoryPoint(
  trajectory,
  time,
  pan,
  tilt,
  commandPan,
  commandTilt,
  horizontal,
  vertical,
  brightness,
  config
) {
  const rawScale = brightness / config.normalizedErrorScale;
  trajectory.push({
    commandPan,
    commandTilt,
    horizontalError: horizontal * rawScale,
    pan,
    tilt,
    time,
    verticalError: vertical * rawScale
  });
}

export function predictTrackerTrajectory(
  telemetry,
  history = [],
  options = {}
) {
  if (!validTelemetry(telemetry)) {
    throw new TypeError(
      "Prediction requires four LDR readings plus numeric pan and tilt commands"
    );
  }

  const config = mergedConfig(options);
  const observation = ldrObservation(telemetry, config);
  const causalHistory = Array.isArray(history)
    ? history.filter(validTelemetry)
    : [];
  const horizonSeconds = clamp(
    finiteNumber(options.horizonSeconds) ??
      estimatePredictionHorizon(
        causalHistory,
        config.predictionHorizonSeconds
      ),
    0.4,
    60
  );
  const models = {
    [LOWER_REGION]: estimateLocalResponseModel(
      causalHistory,
      LOWER_REGION,
      config
    ),
    [UPPER_REGION]: estimateLocalResponseModel(
      causalHistory,
      UPPER_REGION,
      config
    )
  };

  let commandPan = clamp(
    Number(telemetry.pan),
    config.commandMinimum,
    config.commandMaximum
  );
  let commandTilt = clamp(
    Number(telemetry.tilt),
    config.commandMinimum,
    config.commandMaximum
  );
  let pan = commandPan;
  let tilt = commandTilt;
  let opticalHorizontal = observation.horizontal;
  let opticalVertical = observation.vertical;
  let sensedHorizontal = observation.horizontal;
  let sensedVertical = observation.vertical;
  let nextControlTime = 0;
  let nextTrajectoryTime = 0;
  let lockedAtSeconds =
    Math.abs(observation.rawHorizontal) <= config.deadbandAdc &&
    Math.abs(observation.rawVertical) <= config.deadbandAdc
      ? 0
      : null;
  const commandHistory = [
    { pan: commandPan, tilt: commandTilt, time: -Infinity }
  ];
  const trajectory = [];

  appendTrajectoryPoint(
    trajectory,
    0,
    pan,
    tilt,
    commandPan,
    commandTilt,
    sensedHorizontal,
    sensedVertical,
    observation.brightness,
    config
  );
  nextTrajectoryTime += config.trajectorySampleSeconds;

  const steps = Math.max(
    1,
    Math.ceil(horizonSeconds / config.simulationStepSeconds)
  );
  for (let step = 1; step <= steps; step += 1) {
    const previousTime = (step - 1) * config.simulationStepSeconds;
    const time = Math.min(
      horizonSeconds,
      step * config.simulationStepSeconds
    );
    const elapsed = time - previousTime;

    while (nextControlTime <= time + EPSILON) {
      const movement = selectControllerMovement(
        commandPan,
        commandTilt,
        sensedHorizontal,
        sensedVertical,
        observation.brightness,
        models,
        config
      );
      const nextPan = clamp(
        commandPan + movement.pan,
        config.commandMinimum,
        config.commandMaximum
      );
      const nextTilt = clamp(
        commandTilt + movement.tilt,
        config.commandMinimum,
        config.commandMaximum
      );
      if (nextPan !== commandPan || nextTilt !== commandTilt) {
        commandPan = nextPan;
        commandTilt = nextTilt;
        commandHistory.push({
          pan: commandPan,
          tilt: commandTilt,
          time: nextControlTime
        });
      }
      nextControlTime += config.controllerPeriodSeconds;
    }

    const delayedTime = time - config.responseDelaySeconds;
    let delayedCommand = commandHistory[0];
    for (const candidate of commandHistory) {
      if (candidate.time > delayedTime) break;
      delayedCommand = candidate;
    }

    const previousPan = pan;
    const previousTilt = tilt;
    pan = exactFirstOrderStep(
      pan,
      delayedCommand.pan,
      elapsed,
      config.panTimeConstantSeconds
    );
    tilt = exactFirstOrderStep(
      tilt,
      delayedCommand.tilt,
      elapsed,
      config.tiltTimeConstantSeconds
    );

    const responseModel = modelForTilt(models, previousTilt);
    const panMovement = pan - previousPan;
    const tiltMovement = tilt - previousTilt;
    opticalHorizontal +=
      responseModel.matrix[0][0] * panMovement +
      responseModel.matrix[0][1] * tiltMovement;
    opticalVertical +=
      responseModel.matrix[1][0] * panMovement +
      responseModel.matrix[1][1] * tiltMovement;

    sensedHorizontal = exactFirstOrderStep(
      sensedHorizontal,
      opticalHorizontal,
      elapsed,
      config.ldrTimeConstantSeconds
    );
    sensedVertical = exactFirstOrderStep(
      sensedVertical,
      opticalVertical,
      elapsed,
      config.ldrTimeConstantSeconds
    );

    const rawScale =
      observation.brightness / config.normalizedErrorScale;
    const insideDeadband =
      Math.abs(sensedHorizontal * rawScale) <= config.deadbandAdc &&
      Math.abs(sensedVertical * rawScale) <= config.deadbandAdc;
    if (insideDeadband && lockedAtSeconds === null) {
      lockedAtSeconds = time;
    }

    if (
      time + EPSILON >= nextTrajectoryTime ||
      Math.abs(time - horizonSeconds) <= EPSILON
    ) {
      appendTrajectoryPoint(
        trajectory,
        time,
        pan,
        tilt,
        commandPan,
        commandTilt,
        sensedHorizontal,
        sensedVertical,
        observation.brightness,
        config
      );
      nextTrajectoryTime += config.trajectorySampleSeconds;
    }
  }

  const activeModel = modelForTilt(models, Number(telemetry.tilt));
  return {
    commandPan,
    commandTilt,
    confidence: activeModel.confidence,
    horizontalError: trajectory.at(-1).horizontalError,
    horizonSeconds,
    lockedAtSeconds,
    model: activeModel,
    modelSource: activeModel.source,
    pan,
    tilt,
    trajectory,
    transferFunctions: {
      ldr: `1 / (${config.ldrTimeConstantSeconds.toFixed(2)}s + 1)`,
      pan:
        `e^(-${config.responseDelaySeconds.toFixed(2)}s) / ` +
        `(${config.panTimeConstantSeconds.toFixed(2)}s + 1)`,
      tilt:
        `e^(-${config.responseDelaySeconds.toFixed(2)}s) / ` +
        `(${config.tiltTimeConstantSeconds.toFixed(2)}s + 1)`
    },
    verticalError: trajectory.at(-1).verticalError
  };
}

export function predictionErrorDegrees(prediction, actualTelemetry) {
  if (
    !prediction ||
    !validTelemetry(actualTelemetry) ||
    finiteNumber(prediction.pan) === null ||
    finiteNumber(prediction.tilt) === null
  ) {
    return null;
  }
  return Math.hypot(
    Number(prediction.pan) - Number(actualTelemetry.pan),
    Number(prediction.tilt) - Number(actualTelemetry.tilt)
  );
}
