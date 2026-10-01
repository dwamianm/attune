/**
 * The AWS Lambda entry for the deployed copy (README, "Deploy to AWS").
 *
 * CloudFront serves the web app from S3 and forwards /api/* here, after its
 * password gate, with the EDGE_SECRET_HEADER secret. The routes, rate limits,
 * and validation are the same app.ts the local server runs (index.ts); only
 * the loopback checks give way to EdgeAccess (guard.ts).
 */
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  // Refusing to start beats answering without the gate's proof.
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const handler = handle(createApp({ edge: { secret: required("ORIGIN_SECRET"), origin: required("PUBLIC_ORIGIN") } }));
