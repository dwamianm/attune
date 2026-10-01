import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdaptScheduler, type SendArgs } from "./scheduler.ts";

/** A send() whose requests stay open until the test resolves them. */
function controllableSend() {
  const calls: { args: SendArgs; at: number; resolve: () => void }[] = [];
  const send = vi.fn((args: SendArgs) => new Promise<void>((resolve) => calls.push({ args, at: Date.now(), resolve })));
  return { send, calls };
}

function make(send: (args: SendArgs) => Promise<void>, onBusyChange?: (busy: boolean) => void) {
  return new AdaptScheduler({
    send,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...(onBusyChange ? { onBusyChange } : {}),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AdaptScheduler", () => {
  it("debounces: one request 700 ms after the last trigger", async () => {
    const { send, calls } = controllableSend();
    const s = make(send);
    s.notify("item_open");
    await vi.advanceTimersByTimeAsync(300);
    s.notify("filter");
    await vi.advanceTimersByTimeAsync(300);
    s.notify("search");
    await vi.advanceTimersByTimeAsync(699);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0].at).toBe(1300);
    expect(calls[0].args).toMatchObject({ trigger: "search", kind: "auto" });
  });

  it("caps the wait at 2500 ms during continuous activity", async () => {
    const { send, calls } = controllableSend();
    const s = make(send);
    for (let t = 0; t < 4000; t += 400) {
      s.notify("item_open");
      await vi.advanceTimersByTimeAsync(400);
      if (send.mock.calls.length) break;
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0].at).toBe(2500);
  });

  it("keeps one request in flight and sends exactly one follow-up", async () => {
    const { send, calls } = controllableSend();
    const busy: boolean[] = [];
    const s = make(send, (b) => busy.push(b));
    s.notify("item_open");
    await vi.advanceTimersByTimeAsync(700);
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.busy).toBe(true);

    // Triggers during the flight only mark the state dirty.
    s.notify("filter");
    await vi.advanceTimersByTimeAsync(100);
    s.notify("search");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(s.pending).toBe(true);

    // The flight ends at 5800; the follow-up waits at least 1000 ms after it.
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1].at - 5_800).toBe(1_000);
    expect(calls[1].args.trigger).toBe("search");

    calls[1].resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([true, false, true, false]);
  });

  it("keeps the minimum gap between requests even after the debounce", async () => {
    const { send, calls } = controllableSend();
    const s = make(send);
    s.notify("item_open");
    await vi.advanceTimersByTimeAsync(700);
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0); // Flight ends at 700.
    s.notify("filter"); // Debounce says 1400; the gap says 1700.
    await vi.advanceTimersByTimeAsync(700);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1].at).toBe(1_700);
  });

  it("sends commands at once and aborts an in-flight background request", async () => {
    const { send, calls } = controllableSend();
    const s = make(send);
    s.notify("item_open");
    await vi.advanceTimersByTimeAsync(700);
    const background = calls[0].args.signal;

    s.notify("filter"); // Pending, will be covered by the command.
    const done = s.command("who owes us");
    expect(send).toHaveBeenCalledTimes(2);
    expect(background.aborted).toBe(true);
    expect(calls[1].args).toMatchObject({ kind: "command", command: "who owes us", trigger: "command" });
    expect(calls[1].at).toBe(700);

    // The aborted request finishing late must not end the command's flight.
    calls[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.busy).toBe(true);

    calls[1].resolve();
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(s.busy).toBe(false);
  });

  it("skips the debounce for a command even with nothing in flight", async () => {
    const { send } = controllableSend();
    const s = make(send);
    s.notify("item_open");
    void s.command("atlas");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].kind).toBe("command");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1); // The pending debounce was dropped.
  });

  it("flushes now, and cancel aborts and drops pending work", async () => {
    const { send, calls } = controllableSend();
    const s = make(send);
    void s.flush("manual");
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls[0].args.kind).toBe("manual");
    s.notify("filter");
    s.cancel();
    expect(calls[0].args.signal.aborted).toBe(true);
    expect(s.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("survives a send that rejects", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = make(send);
    s.notify("item_open");
    await vi.advanceTimersByTimeAsync(700);
    expect(s.busy).toBe(false);
    s.notify("filter");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
