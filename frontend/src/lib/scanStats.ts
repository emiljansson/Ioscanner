// Tiny rolling-average ETA tracker. We persist the last MAX_SAMPLES scan
// durations and use their mean as our estimate. Lives in AsyncStorage so it
// survives app restarts (unlike a Context).

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "copythat.scanStats.v1";
const MAX_SAMPLES = 8;
// Reasonable fallback when we have no history yet (seconds).
const DEFAULT_ETA_SECONDS = 18;

type Stats = {
  // Seconds, oldest first.
  durations: number[];
};

async function read(): Promise<Stats> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return { durations: [] };
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.durations)) {
      return {
        durations: parsed.durations
          .filter((n: unknown) => typeof n === "number" && isFinite(n) && n > 0)
          .slice(-MAX_SAMPLES),
      };
    }
  } catch (e) {
    console.warn("[scanStats] read failed", e);
  }
  return { durations: [] };
}

async function write(stats: Stats): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(stats));
  } catch (e) {
    console.warn("[scanStats] write failed", e);
  }
}

export type EtaInfo = {
  /** Best-guess seconds for the *next* scan. Always a number. */
  seconds: number;
  /** How many historical samples we used (0 = pure default, no real data). */
  samples: number;
};

/** Returns the current ETA. Never throws – falls back to DEFAULT_ETA_SECONDS. */
export async function getEta(): Promise<EtaInfo> {
  const { durations } = await read();
  if (durations.length === 0) {
    return { seconds: DEFAULT_ETA_SECONDS, samples: 0 };
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  // Clamp into something believable so a single 60s outlier doesn't poison
  // the next 10 estimates.
  const clamped = Math.max(4, Math.min(60, avg));
  return { seconds: clamped, samples: durations.length };
}

/** Append a duration sample. Silently ignored if the value looks bogus. */
export async function recordDuration(seconds: number): Promise<void> {
  if (!isFinite(seconds) || seconds <= 0 || seconds > 120) return;
  const stats = await read();
  const next = [...stats.durations, Math.round(seconds * 10) / 10].slice(
    -MAX_SAMPLES
  );
  await write({ durations: next });
}
