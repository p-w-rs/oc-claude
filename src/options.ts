import type { BridgeOptions } from "./bridge.js";

export function parseOptions(input: Record<string, unknown>): Pick<BridgeOptions, "maxConcurrent" | "timeoutMs" | "startupTimeoutMs" | "idleTimeoutMs"> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!["maxConcurrent", "timeoutMs", "startupTimeoutMs", "idleTimeoutMs"].includes(key)) throw new Error(`Unknown OpenClaude option: ${key}`);
    const maximum = key === "maxConcurrent" ? 64 : 3_600_000;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`OpenClaude ${key} must be an integer from 1 to ${maximum}`);
    result[key] = value;
  }
  return result;
}
