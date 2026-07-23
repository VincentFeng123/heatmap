# COSMOS Solar Digital Twin

A Vercel-ready wireframe digital twin for the COSMOS two-axis solar tracker.
The ESP32 publishes its four LDRs, servo commands, and calculated sun position
to ThingSpeak; the site mirrors that state as a moving engineering model.

The dashboard includes:

- a live pan/tilt wireframe with an interpolated light texture;
- a causal Laplace-derived servo and LDR trajectory forecast;
- separate panel-facing and astronomical sun vectors;
- commanded pan/tilt rotation readouts;
- predicted-versus-facing angular error after sun-lock calibration;
- the original dense four-corner heatmap;
- firmware-matching horizontal/vertical LDR errors and `+/-30` balance state;
- stale, partial, paused, and connection-health indicators; and
- responsive desktop and mobile layouts.

Lower ADC values are treated as brighter light. The first balanced, strong,
above-horizon sample calibrates the relative servo frame to the sun, except at
the straight-up tilt singularity where azimuth is undefined.

## Laplace-derived prediction

The forecast is generated from the selected telemetry sample and samples that
occurred before it. It never uses the next sample as an input. During history
playback, the next sample is withheld until after prediction and is used only
to display replay error.

The LDR filter uses the same first-order plant as the firmware:

```text
Hldr(s) = 1 / (0.08s + 1)
```

The loaded pan and tilt mechanisms are represented by first-order plants with
transport delay:

```text
Gp(s) = exp(-0.12s) / (0.35s + 1)
Gt(s) = exp(-0.12s) / (0.45s + 1)
```

The browser evaluates the exact zero-order-hold time-domain response
`x(t + dt) = target + (x(t) - target) * exp(-dt / tau)`. A firmware-matching
controller advances the two servo commands from the four LDR balance errors,
then the transfer functions propagate predicted shaft motion and filtered
sensor response across the expected telemetry interval.

The predictor starts with the firmware's two local response Jacobian priors,
one on each side of the stacked mount's pan-reversal band. When causal history
contains usable independent pan and tilt changes, a ridge-regularized local
fit blends measured command-to-LDR response into those priors. The UI labels
the result `calibrating` until enough observations are available and reports
the response-model confidence.

The time constants are engineering estimates for a loaded SG90 mechanism.
They become calibrated physical predictions only after measuring shaft motion
with an encoder, feedback potentiometer, or equivalent external observation.
ThingSpeak fields 5 and 6 are servo commands rather than shaft measurements,
so history alone cannot identify the true mechanical time constants.

## ThingSpeak fields

1. Top-left LDR raw ADC
2. Top-right LDR raw ADC
3. Bottom-left LDR raw ADC
4. Bottom-right LDR raw ADC
5. Pan servo angle
6. Tilt servo angle
7. Estimated sun azimuth in degrees
8. Estimated sun elevation in degrees

## Deploy on Vercel

Import this GitHub repository into Vercel and add these project environment
variables for Production, Preview, and Development:

```text
THINGSPEAK_CHANNEL_ID=3432834
THINGSPEAK_READ_API_KEY=your_read_api_key
```

The app defaults to channel `3432834`, so the channel variable is optional
unless you want to override it later.

Leave `THINGSPEAK_READ_API_KEY` empty only when the channel is public. For a
private channel, copy the **Read API Key** from ThingSpeak's API Keys tab. Never
put the Write API key in this repository or in browser JavaScript.

No build command or output-directory override is needed. Vercel serves
`index.html` and runs `api/latest.js` as a serverless function.

ThingSpeak retains the historical channel feed even though this first dashboard
focuses on the latest sample. A future history view can replay those stored
samples without changing the firmware.

## Verify locally with simulated data

```bash
npm test
npm run preview:simulated
```

Open `http://127.0.0.1:4173`. The simulator cycles through every bright corner
and a balanced reading while supplying realistic sun azimuth and elevation
values. The site polls every five seconds and redraws only when the ThingSpeak
entry changes.

The ESP32 needs the MathWorks ThingSpeak Arduino library; `WiFi.h` is already
included with the ESP32 Arduino board package.

## Model limitation

Fields 5 and 6 are servo commands, not measured shaft angles. Standard SG90
servos do not report their real position or a stall, so this is a
command-driven dynamic estimate. Encoders or feedback servos would turn the
pose and transfer-function calibration into measured physical state. Likewise,
four corner LDRs create an interpolated light field rather than a dense camera
measurement.
