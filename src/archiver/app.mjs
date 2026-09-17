import { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "./lib/config.mjs";
import { createHandler } from "./lib/handler.mjs";

// Created once per execution environment so warm invocations reuse
// connections. Extra attempts absorb S3 503 SlowDown responses during bursts.
const s3 = new S3Client({ maxAttempts: 5 });

export const handler = createHandler({ s3, config: loadConfig(process.env) });
