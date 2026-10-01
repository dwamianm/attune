/**
 * The health check retries with backoff while the server is down, so the
 * status recovers when the server starts after the page (K8).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, commandFailureMessage, watchHealth, type HealthResult } from "./api.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("watchHealth", () => {
  it("retries with backoff until the server answers, then stops", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const check = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new ApiError("network", "Cannot reach the local server");
      return { ok: true, jev: true };
    });
    const results: HealthResult[] = [];
    watchHealth({ check, onResult: (r) => results.push(r), delays: [100, 200] });
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => r.ok)).toEqual([false]);
    await vi.advanceTimersByTimeAsync(100);
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(199);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(results.map((r) => r.ok)).toEqual([false, false, true]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("can be stopped", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => {
      throw new ApiError("network", "down");
    });
    const stop = watchHealth({ check, onResult: () => {}, delays: [50] });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe("commandFailureMessage", () => {
  it("tells a refusal, a timeout, and a dead server apart", () => {
    expect(commandFailureMessage(new ApiError("http", "Server answered 400: too long.", 400, "too long."))).toBe("The server could not use that command: too long.");
    expect(commandFailureMessage(new ApiError("timeout", "No answer"))).toBe("The server took too long to answer. Try again.");
    expect(commandFailureMessage(new ApiError("network", "down"))).toBe("Could not reach the server. Try again.");
  });
});
