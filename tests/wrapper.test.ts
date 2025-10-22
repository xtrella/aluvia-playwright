import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ALUVIA_API_KEY = "test_key";
process.env.ALUVIA_MAX_RETRIES = "1";
process.env.ALUVIA_BACKOFF_MS = "50";
process.env.ALUVIA_RETRY_ON = "ETIMEDOUT,net::ERR";

vi.mock("playwright", async () => {
  const mod = await import("./__mocks__/playwright");
  return mod;
});

vi.mock("aluvia-ts-sdk", async () => {
  const mod = await import("./__mocks__/aluvia-ts-sdk");
  return { default: mod.default };
});

describe("Aluvia Playwright wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  it("retries goto once, backs off, relaunches with a new proxy, and succeeds", async () => {
    const pw = await import("playwright");

    pw.chromium.__setGotoImpl(async () => {
      const err: any = new Error("Timeout navigating");
      err.code = "ETIMEDOUT";
      throw err;
    });

    const wrapper = await import("../src/index");

    const browser = await wrapper.chromium.launch({});
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Flip to success for the relaunch attempt
    pw.chromium.__setGotoImpl(async () => ({ ok: true, status: 200 }));

    const gotoPromise = page.goto("https://example.com");
    await vi.runAllTimersAsync();

    const resp = await gotoPromise;
    expect(resp).toBeTruthy();
    expect(resp!.status).toBe(200);
  });

  it("does not retry when error does not match ALUVIA_RETRY_ON", async () => {
    const pw = await import("playwright");

    // Non-retryable failure (set BEFORE importing wrapper)
    pw.chromium.__setGotoImpl(async () => {
      const err: any = new Error("Some other error");
      err.code = "EBADF"; // not in ALUVIA_RETRY_ON
      throw err;
    });

    const wrapper = await import("../src/index");

    const browser = await wrapper.chromium.launch({});
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // No timers to run in this test (no retry/backoff path)
    await expect(page.goto("https://example.com")).rejects.toThrow(
      /Some other error/
    );
  });

  it("mirrors events from the new page back to the original page", async () => {
    const pw = await import("playwright");

    // First goto fails (retryable), set BEFORE importing wrapper
    pw.chromium.__setGotoImpl(async () => {
      const err: any = new Error("net::ERR_CONNECTION_RESET");
      err.code = "net::ERR_CONNECTION_RESET";
      throw err;
    });

    const wrapper = await import("../src/index");

    const browser = await wrapper.chromium.launch({});
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const handler = vi.fn();
    page.on("load", handler);

    // Success for relaunch
    pw.chromium.__setGotoImpl(async () => ({ ok: true, status: 200 }));

    const p = page.goto("https://example.com");
    await vi.runAllTimersAsync();
    await p;

    // Emit from the (forwarded) page handle; mirroring should deliver to original listener
    page.emit("load");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
