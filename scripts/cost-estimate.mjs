#!/usr/bin/env node
/**
 * Monthly cost model for the S3 ZIP archiver at the assessment's scale.
 * Prints the tables used in the README's cost analysis.
 *
 *   node scripts/cost-estimate.mjs
 *
 * Prices: AWS Price List API, ap-southeast-1 (Singapore), offer files
 * published 2026-09 (Lambda, S3, CloudWatch, SQS, ECR, EC2 for NAT gateway).
 * S3 and CloudWatch bill storage in binary gigabytes (GiB), shown as "GB".
 * The figures are gross on-demand prices: Free Tier allowances, other usage
 * in the account and duplicate deliveries/retries are not included.
 * Edit ASSUMPTIONS to re-run the estimate with production measurements.
 */

const HOURS_PER_MONTH = 730;
const GIB = 1024 ** 3;

const ASSUMPTIONS = {
  filesPerHour: 1_000_000,
  avgFileBytes: 10 * 1000 ** 2, // "10 MB" as stated in the brief (decimal)
  // src/archiver/bench/compression.mjs, synthetic detection JSON, per zlib level
  compressionRatio: { 1: 4.01, 6: 4.69, 9: 4.78 },
  // Median wall time to compress 10 MiB inside the Lambda image capped at
  // 0.58 vCPU (= 1,024 MB) on an Apple M5, scaled by gravitonSlowdown for
  // Lambda's Graviton2 CPUs. Both factors are estimates to replace with
  // measured Lambda durations after deployment.
  benchSec: { 1: 0.098, 6: 0.185, 9: 0.367 },
  gravitonSlowdown: 2.5,
  // TTFB of the GET, ~2 MB PUT after compression, a HEAD and a DELETE.
  s3IoSec: 0.25,
  // The trigger covers the whole bucket, so each archive written by the
  // function invokes it once more and is skipped without any S3 call.
  skipInvocationSec: 0.005,
  // ~200 warm environments, each replaced roughly every 2 hours, ~1.5 s INIT
  // for a cached container image.
  coldStartsPerMonth: 200 * 12 * 30,
  initSec: 1.5,
  compressionLevel: 6,
  lambdaMemoryMb: 1024,
  logBytesPerFile: 450, // one INFO JSON line per archived object (uncompressed)
  logRetentionDays: 14,
  // S3 requests per archived object: the ~2 MB archive is below the 5 MiB
  // multipart threshold, so it is a single PUT; the DELETE is free.
  requestsPerFile: { get: 1, put: 1, head: 1 },
};

const PRICE = {
  lambdaRequest: 0.2 / 1e6,
  // arm64 duration tiers per account/region per month: [upper GB-s, USD]
  lambdaArmGbSecond: [
    [7.5e9, 0.0000133334],
    [18.75e9, 0.0000120001],
    [Infinity, 0.0000106667],
  ],
  s3Standard: { put: 0.005 / 1000, get: 0.0004 / 1000 },
  s3GlacierIr: { put: 0.02 / 1000, get: 0.01 / 1000, gbMonth: 0.005, retrievalGb: 0.03 },
  s3IntelligentTiering: { monitoringPerObject: 0.0025 / 1000, infrequentGbMonth: 0.0138, archiveInstantGbMonth: 0.005 },
  // S3 Standard (and Intelligent-Tiering frequent access) storage tiers
  s3StandardGbMonth: [
    [51_200, 0.025],
    [512_000, 0.024],
    [Infinity, 0.023],
  ],
  logsIngestGb: 0.7, // Lambda (vended) logs, first 10 TB
  logsStorageGbMonth: 0.03,
  alarmMonth: 0.1,
  sqsRequest: 0.4 / 1e6,
  ecrGbMonth: 0.1,
  natGateway: { gbProcessed: 0.059, hour: 0.059 },
};

const usd = (n) => {
  const digits = Math.abs(n) < 10 ? 2 : 0;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
};
const num = (n, digits = 0) => n.toLocaleString("en-US", { maximumFractionDigits: digits });

function tiered(quantity, tiers) {
  let remaining = quantity;
  let lower = 0;
  let cost = 0;
  for (const [upper, rate] of tiers) {
    const inTier = Math.min(remaining, upper - lower);
    if (inTier <= 0) break;
    cost += inTier * rate;
    remaining -= inTier;
    lower = upper;
  }
  return cost;
}

// Lambda bills each invocation rounded up to the millisecond.
const billedSec = (sec) => Math.ceil(sec * 1000 - 1e-9) / 1000;

function model(overrides = {}) {
  const a = ASSUMPTIONS;
  const level = overrides.level ?? a.compressionLevel;
  const ratio = overrides.ratio ?? a.compressionRatio[level];
  const duration = billedSec(overrides.durationSec ?? a.benchSec[level] * a.gravitonSlowdown + a.s3IoSec);
  const logBytes = overrides.logBytesPerFile ?? a.logBytesPerFile;
  const memoryGb = a.lambdaMemoryMb / 1024;
  const requestPrice = overrides.storageClass === "GLACIER_IR" ? PRICE.s3GlacierIr : PRICE.s3Standard;

  const files = a.filesPerHour * HOURS_PER_MONTH;
  const originalGb = (files * a.avgFileBytes) / GIB;
  const archiveGb = originalGb / ratio;
  const skipInvocations = overrides.sourcePrefix ? 0 : files;
  const invocations = files + skipInvocations;
  const gbSeconds =
    (files * duration + skipInvocations * billedSec(a.skipInvocationSec) + a.coldStartsPerMonth * a.initSec) * memoryGb;
  const logGb = (files * logBytes) / GIB;

  const items = {
    lambdaRequests: invocations * PRICE.lambdaRequest,
    lambdaCompute: tiered(gbSeconds, PRICE.lambdaArmGbSecond),
    s3Put: files * a.requestsPerFile.put * requestPrice.put,
    s3Get: files * a.requestsPerFile.get * PRICE.s3Standard.get,
    s3Head: files * a.requestsPerFile.head * requestPrice.get,
    logsIngest: logGb * PRICE.logsIngestGb,
    // Upper bound: CloudWatch bills stored logs after compression.
    logsStorage: logGb * ((a.logRetentionDays * 24) / HOURS_PER_MONTH) * PRICE.logsStorageGbMonth,
    other: PRICE.alarmMonth + 0.3 * PRICE.ecrGbMonth + 1000 * PRICE.sqsRequest,
  };
  const feature = Object.values(items).reduce((sum, value) => sum + value, 0);

  return { level, ratio, duration, files, invocations, skipInvocations, originalGb, archiveGb, gbSeconds, logGb, items, feature };
}

const standardStorage = (gb) => tiered(gb, PRICE.s3StandardGbMonth);
// Month N of a bucket that starts empty and keeps everything: the average
// stored volume during month N is (N - 0.5) months of data.
const monthStorage = (n, monthlyGb) => standardStorage((n - 0.5) * monthlyGb);

const m = model();
const ingestPuts = m.files * PRICE.s3Standard.put;
const perSecond = m.files / HOURS_PER_MONTH / 3600;
const marginalStandardGb = PRICE.s3StandardGbMonth.at(-1)[1];

console.log("## Volume\n");
console.log("| Metric | Value |\n| --- | --- |");
console.log(`| Files per month (1,000,000/h x ${HOURS_PER_MONTH} h) | ${num(m.files)} |`);
console.log(`| Original data per month (10 MB each) | ${num(m.originalGb)} GB (${num(m.originalGb / 1024 ** 2, 2)} PiB) |`);
console.log(`| Compression ratio (zlib level ${m.level}, benchmark) | ${m.ratio}x |`);
console.log(`| Archived data per month | ${num(m.archiveGb)} GB (${num(m.archiveGb / 1024 ** 2, 2)} PiB) |`);
console.log(`| Billed duration per archived file | ${num(m.duration, 3)} s at ${num(ASSUMPTIONS.lambdaMemoryMb)} MB |`);
console.log(`| Invocations | ${num(perSecond * 2)}/s (${num(perSecond)}/s archiving + ${num(perSecond)}/s skipped archive events) |`);
console.log(`| Concurrent executions (steady state) | ~${num(perSecond * (m.duration + ASSUMPTIONS.skipInvocationSec))} |`);

console.log("\n## Monthly cost of running the feature\n");
const i = m.items;
console.log("| Item | Calculation | USD / month |\n| --- | --- | ---: |");
console.log(`| Lambda requests | ${num(m.invocations / 1e6)} M invocations (archiving + skipped archive events) x $0.20 per M | ${usd(i.lambdaRequests)} |`);
console.log(
  `| Lambda compute (arm64, 1 GB) | (${num(m.files / 1e6)} M x ${num(m.duration, 3)} s + ${num(m.skipInvocations / 1e6)} M x ${ASSUMPTIONS.skipInvocationSec} s + ${num(ASSUMPTIONS.coldStartsPerMonth)} cold starts x ${ASSUMPTIONS.initSec} s) = ${num(m.gbSeconds / 1e6, 1)} M GB-s x $0.0000133334 | ${usd(i.lambdaCompute)} |`,
);
console.log(`| S3 PUT (archive upload, conditional) | ${num(m.files / 1e6)} M x $0.005 per 1,000 | ${usd(i.s3Put)} |`);
console.log(`| S3 GET (read original) | ${num(m.files / 1e6)} M x $0.0004 per 1,000 | ${usd(i.s3Get)} |`);
console.log(`| S3 HEAD (verify stored archive) | ${num(m.files / 1e6)} M x $0.0004 per 1,000 | ${usd(i.s3Head)} |`);
console.log(`| S3 DELETE (conditional) | free | $0.00 |`);
console.log(`| CloudWatch Logs ingestion (INFO) | ${num(m.logGb)} GB x $0.70 | ${usd(i.logsIngest)} |`);
console.log(`| CloudWatch Logs storage (${ASSUMPTIONS.logRetentionDays}-day retention) | <= ${num(m.logGb * ((ASSUMPTIONS.logRetentionDays * 24) / HOURS_PER_MONTH))} GB x $0.03 | ${usd(i.logsStorage)} |`);
console.log(`| Alarm, ECR image (~0.3 GB), SQS failure queue | | ${usd(i.other)} |`);
console.log(`| VPC, S3 gateway endpoint, ENIs, S3 notifications, async queue, in-region transfer, SSE-S3 | free | $0.00 |`);
console.log(`| **Total feature cost** | | **${usd(m.feature)}** |`);

console.log("\n## Storage impact (S3 Standard)\n");
const cohortWithout = standardStorage(m.originalGb);
const cohortWith = standardStorage(m.archiveGb);
console.log("| | Without feature | With feature |\n| --- | ---: | ---: |");
console.log(`| Data added per month | ${num(m.originalGb)} GB | ${num(m.archiveGb)} GB |`);
console.log(`| Storage cost of one month of data, per month kept | ${usd(cohortWithout)} | ${usd(cohortWith)} |`);
console.log(`| Upload PUTs from on-premises (unchanged) | ${usd(ingestPuts)} | ${usd(ingestPuts)} |`);

console.log("\n## Total monthly bill (bucket starts empty, data is kept)\n");
console.log("| Month | Without feature | With feature | Difference |\n| --- | ---: | ---: | ---: |");
for (const n of [1, 2, 3, 6, 12]) {
  const without = monthStorage(n, m.originalGb) + ingestPuts;
  const withFeature = monthStorage(n, m.archiveGb) + ingestPuts + m.feature;
  console.log(`| ${n} | ${usd(without)} | ${usd(withFeature)} | ${usd(withFeature - without)} (${num((withFeature / without - 1) * 100)}%) |`);
}

console.log("\n## Sensitivity of the feature cost\n");
console.log("| Scenario | Feature cost / month |\n| --- | ---: |");
for (const d of [0.5, 1.0, 1.5]) {
  console.log(`| Billed duration ${d} s per archived file | ${usd(model({ durationSec: d }).feature)} |`);
}
for (const r of [3, 8]) {
  const s = model({ ratio: r });
  console.log(`| Compression ratio ${r}x (storage of one month of archives: ${usd(standardStorage(s.archiveGb))}) | ${usd(s.feature)} |`);
}

console.log("\n## Savings options\n");
const warn = model({ logBytesPerFile: 0 });
const scoped = model({ sourcePrefix: "incoming/" });
const level1 = model({ level: 1 });
const level1Compute = m.items.lambdaCompute - level1.items.lambdaCompute;
const level1Storage = (level1.archiveGb - m.archiveGb) * marginalStandardGb;
const gir = model({ storageClass: "GLACIER_IR" });
const girRequests = gir.feature - m.feature;
const girSaving = m.archiveGb * (marginalStandardGb - PRICE.s3GlacierIr.gbMonth);
const it = PRICE.s3IntelligentTiering;
const itMonitoring = m.files * it.monitoringPerObject;
const itInfrequent = m.archiveGb * (marginalStandardGb - it.infrequentGbMonth) - itMonitoring;
const itArchive = m.archiveGb * (marginalStandardGb - it.archiveInstantGbMonth) - itMonitoring;

// Bundling N files per archive via S3 -> SQS -> Lambda batches.
const bundle = 100;
const bundles = m.files / bundle;
const parts = Math.ceil((bundle * (ASSUMPTIONS.avgFileBytes / m.ratio)) / (5 * 1024 ** 2));
const bundledRequests =
  bundles * PRICE.lambdaRequest +
  bundles * (parts + 2) * PRICE.s3Standard.put + // create + parts + complete
  bundles * PRICE.s3Standard.get + // HEAD per archive
  (m.files + 2 * (m.files / 10)) * PRICE.sqsRequest + // send, batched receive and delete
  (bundles * ASSUMPTIONS.logBytesPerFile * PRICE.logsIngestGb) / GIB;
const currentRequests = m.items.lambdaRequests + m.items.s3Put + m.items.s3Head + m.items.logsIngest;
const natGb = (m.files * ASSUMPTIONS.avgFileBytes * (1 + 1 / m.ratio)) / GIB;

console.log("| Option | Effect |\n| --- | --- |");
console.log(`| ApplicationLogLevel=WARN | ${usd(warn.feature - m.feature)} per month |`);
console.log(`| SourcePrefix=incoming/ (archives no longer invoke the function) | ${usd(scoped.feature - m.feature)} per month |`);
console.log(`| Compute Savings Plan (up to 17% of Lambda duration) | up to ${usd(-0.17 * m.items.lambdaCompute)} per month |`);
console.log(
  `| ArchiveStorageClass=INTELLIGENT_TIERING | +${usd(itMonitoring)} monitoring per month of data kept; each month of archives then saves ${usd(itInfrequent)}/month after 30 days (Infrequent Access) and ${usd(itArchive)}/month after 90 days (Archive Instant Access); no retrieval fees |`,
);
console.log(
  `| ArchiveStorageClass=GLACIER_IR | +${usd(girRequests)} per month in PUT/HEAD requests; each month of archives saves ${usd(girSaving)}/month from day one; $0.03/GB and $0.01/1,000 GETs to read; 90-day minimum |`,
);
console.log(
  `| Compression level 1 instead of 6 | ${usd(-level1Compute)} per month compute, +${usd(level1Storage)}/month storage per month of data kept (level 6 is cheaper once data is kept ~${num((level1Compute / level1Storage) * 30)} days) |`,
);
console.log(
  `| Bundle ${bundle} files per archive (S3 -> SQS -> Lambda batches) | about ${usd(bundledRequests - currentRequests)} per month in requests and logs after ${parts}-part uploads and SQS charges; compute not modelled |`,
);
console.log(`| Compress on-premises before upload | ${usd(-m.feature)} per month (no function) and ~${num((1 - 1 / m.ratio) * 100)}% less upload bandwidth |`);
console.log(
  `| Already avoided by design: NAT gateway for S3 traffic | ${usd(natGb * PRICE.natGateway.gbProcessed + 2 * HOURS_PER_MONTH * PRICE.natGateway.hour)} per month (${num(natGb)} GB processed + 2 gateways) |`,
);
