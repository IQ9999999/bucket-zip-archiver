/**
 * Compression benchmark used for the README cost analysis.
 *
 * Generates a deterministic ~10 MB video-analysis JSON document (per-frame
 * detections with float confidences and bounding boxes), then streams it
 * through the same ZipArchive pipeline the function uses and reports the
 * compression ratio and CPU time per zlib level. S3 network time is not
 * included.
 *
 * Run inside the Lambda image with a CPU cap that mirrors the function's
 * memory setting (Lambda allocates ~1 vCPU per 1,769 MB):
 *
 *   docker run --rm --cpus 0.58 --entrypoint node \
 *     -v "$PWD/src/archiver/bench:/var/task/bench:ro" \
 *     archiverfunction:nodejs24 /var/task/bench/compression.mjs
 */
import { PassThrough, Readable, Writable } from "node:stream";
import { ZipArchive } from "archiver";

const TARGET_BYTES = Number(process.env.TARGET_BYTES ?? 10 * 1024 * 1024);
const LEVELS = (process.env.LEVELS ?? "1,6,9").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 5);
const LABELS = ["person", "car", "bicycle", "dog", "traffic light", "backpack", "handbag", "bus", "truck", "chair"];

// Small seeded PRNG so every run compresses identical input.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDocument(targetBytes) {
  const random = mulberry32(42);
  const round = (value, digits) => Number(value.toFixed(digits));
  const header = {
    videoId: "vid-2026-09-17-000123",
    source: { uri: "s3://media-ingest/raw/2026/09/17/000123.mp4", codec: "h264", width: 3840, height: 2160, fps: 29.97 },
    model: { name: "object-detector", version: "4.2.1", threshold: 0.35 },
  };
  const frames = [];
  let size = JSON.stringify(header).length;
  for (let frame = 0; size < targetBytes; frame++) {
    const detections = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
      label: LABELS[Math.floor(random() * LABELS.length)],
      confidence: round(0.35 + random() * 0.65, 6),
      bbox: [round(random() * 3840, 1), round(random() * 2160, 1), round(20 + random() * 600, 1), round(20 + random() * 600, 1)],
      trackId: Math.floor(random() * 500),
    }));
    const entry = {
      frame,
      timestampMs: round((frame * 1000) / 29.97, 3),
      sceneScore: round(random(), 4),
      audio: { rmsDb: round(-60 + random() * 50, 2), speech: random() > 0.6 },
      detections,
    };
    size += JSON.stringify(entry).length + 1;
    frames.push(entry);
  }
  return Buffer.from(JSON.stringify({ ...header, frames }));
}

async function zipOnce(input, level) {
  const archive = new ZipArchive({ zlib: { level } });
  const output = new PassThrough();
  let bytes = 0;
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback();
    },
  });
  archive.pipe(output).pipe(sink);

  // Feed in 64 KiB chunks, like an S3 response body stream.
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += 64 * 1024) {
    chunks.push(input.subarray(offset, offset + 64 * 1024));
  }

  const started = process.hrtime.bigint();
  archive.append(Readable.from(chunks), { name: "result.json" });
  await Promise.all([archive.finalize(), new Promise((resolve) => sink.on("finish", resolve))]);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { bytes, ms };
}

const input = generateDocument(TARGET_BYTES);
console.log(`Input: ${(input.length / 1024 / 1024).toFixed(2)} MiB synthetic video-analysis JSON, ${RUNS} runs per level`);
console.log("level | archive MiB | ratio | saved | median ms | MiB/s");

for (const level of LEVELS) {
  await zipOnce(input, level); // warm-up
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await zipOnce(input, level));
  const median = runs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const { bytes } = runs[0];
  console.log(
    [
      String(level).padStart(5),
      (bytes / 1024 / 1024).toFixed(2).padStart(11),
      (input.length / bytes).toFixed(2).padStart(5),
      `${((1 - bytes / input.length) * 100).toFixed(1)}%`.padStart(5),
      median.toFixed(0).padStart(9),
      (input.length / 1024 / 1024 / (median / 1000)).toFixed(1).padStart(5),
    ].join(" | "),
  );
}
