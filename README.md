# COSMOS Solar Heatmap

A Vercel-ready live heatmap for the four LDR sensors and two servos published
by the ESP32 to ThingSpeak. Lower ADC values are treated as brighter light.

## ThingSpeak fields

1. Top-left LDR raw ADC
2. Top-right LDR raw ADC
3. Bottom-left LDR raw ADC
4. Bottom-right LDR raw ADC
5. Pan servo angle
6. Tilt servo angle

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

## Verify locally with simulated data

```bash
npm test
npm run preview:simulated
```

Open `http://127.0.0.1:4173`. The simulator cycles through every bright corner
and a balanced reading. The site polls every five seconds and redraws only when
the ThingSpeak entry changes.

The ESP32 needs the MathWorks ThingSpeak Arduino library; `WiFi.h` is already
included with the ESP32 Arduino board package.
