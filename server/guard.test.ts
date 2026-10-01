/**
 * The API spends the Jev key, so it only answers the app on this machine:
 * loopback Host, loopback or no Origin, JSON bodies, and a rate limit.
 */
import { describe, expect, it } from "vitest";
import { checkRequest, createRateLimiter, isLoopbackHost } from "./guard.ts";

describe("checkRequest", () => {
  const json = "application/json";

  it("lets the app through, directly or through the Vite proxy", () => {
    expect(checkRequest({ host: "localhost:8790", contentType: json }, { requireJson: true })).toBeNull();
    expect(checkRequest({ host: "localhost:5173", origin: "http://localhost:5173", contentType: `${json}; charset=utf-8` }, { requireJson: true })).toBeNull();
    expect(checkRequest({ host: "127.0.0.1:8790" }, { requireJson: false })).toBeNull();
    expect(checkRequest({ host: "[::1]:8790", origin: "http://[::1]:5176", contentType: json }, { requireJson: true })).toBeNull();
  });

  it("refuses other hosts (DNS rebinding) and other sites", () => {
    expect(checkRequest({ host: "attacker.example:8790", contentType: json }, { requireJson: true })?.status).toBe(403);
    expect(checkRequest({ host: "192.168.86.74:8790", contentType: json }, { requireJson: true })?.status).toBe(403);
    expect(checkRequest({ host: undefined }, { requireJson: false })?.status).toBe(403);
    expect(checkRequest({ host: "localhost:8790", origin: "https://evil.example", contentType: json }, { requireJson: true })?.status).toBe(403);
    expect(checkRequest({ host: "localhost:8790", origin: "null", contentType: json }, { requireJson: true })?.status).toBe(403);
  });

  it("refuses a body that is not declared JSON, which a cross-site form could send", () => {
    expect(checkRequest({ host: "localhost:8790", contentType: "text/plain" }, { requireJson: true })).toMatchObject({ status: 415 });
    expect(checkRequest({ host: "localhost:8790" }, { requireJson: true })).toMatchObject({ status: 415 });
  });

  it("behind CloudFront, wants the gate's secret and the site's own Origin instead of loopback", () => {
    const edge = { secret: "s3cret-value", origin: "https://attuneui.com" };
    const lambdaHost = "abc123.lambda-url.us-west-1.on.aws";
    expect(checkRequest({ host: lambdaHost, origin: edge.origin, contentType: json, edgeSecret: edge.secret }, { requireJson: true, edge })).toBeNull();
    expect(checkRequest({ host: lambdaHost, edgeSecret: edge.secret }, { requireJson: false, edge })).toBeNull();
    // Straight to the Lambda URL, around the password gate.
    expect(checkRequest({ host: lambdaHost, origin: edge.origin, contentType: json }, { requireJson: true, edge })?.status).toBe(403);
    expect(checkRequest({ host: lambdaHost, contentType: json, edgeSecret: "s3cret-valuf" }, { requireJson: true, edge })?.status).toBe(403);
    expect(checkRequest({ host: lambdaHost, contentType: json, edgeSecret: "short" }, { requireJson: true, edge })?.status).toBe(403);
    // Other sites, the CloudFront default name, and a loopback page.
    for (const origin of ["https://evil.example", "https://d111.cloudfront.net", "http://localhost:5173", "null"]) {
      expect(checkRequest({ host: lambdaHost, origin, contentType: json, edgeSecret: edge.secret }, { requireJson: true, edge })?.status).toBe(403);
    }
    expect(checkRequest({ host: lambdaHost, contentType: "text/plain", edgeSecret: edge.secret }, { requireJson: true, edge })?.status).toBe(415);
  });

  it("never takes the secret header as a way around loopback on the local server", () => {
    expect(checkRequest({ host: "attacker.example", contentType: json, edgeSecret: "anything" }, { requireJson: true })?.status).toBe(403);
  });

  it("parses host names with ports and brackets", () => {
    expect(isLoopbackHost("LOCALHOST:1")).toBe(true);
    expect(isLoopbackHost("localhost.evil.example")).toBe(false);
    expect(isLoopbackHost("not a host")).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("allows a burst up to the limit and resets each window", () => {
    let t = 0;
    const allow = createRateLimiter(3, 1_000, () => t);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    t = 999;
    expect(allow()).toBe(false);
    t = 1_000;
    expect(allow()).toBe(true);
  });
});
