# S3 ZIP Archiver

An AWS Lambda function, deployed with AWS SAM, that compresses every new object in an S3 bucket into a ZIP archive in the same bucket and then deletes the original. The function runs as a container image in private subnets of a dedicated VPC, and every deployment publishes a new Lambda version so releases can be rolled back.

- [Architecture](#architecture)
- [How the assessment tasks are covered](#how-the-assessment-tasks-are-covered)
- [Repository layout](#repository-layout)
- [Design decisions](#design-decisions)
- [Cost analysis](#cost-analysis)
- [Scalability and bottlenecks](#scalability-and-bottlenecks)
- [Local development and testing](#local-development-and-testing)
- [Deployment](#deployment)
- [Rollback](#rollback)
- [Teardown](#teardown)

## Architecture

```mermaid
flowchart LR
    onprem["On-premises video processing"] -- "PUT result.json" --> bucket[("S3 bucket")]
    bucket -- "s3:ObjectCreated:*" --> alias["Lambda alias: live"]
    subgraph vpc["Custom VPC (private subnets only, no NAT/IGW)"]
        fn["Archiver function<br/>Node.js 24 container image, arm64"]
        gw["S3 gateway endpoint"]
    end
    alias --> fn
    fn -- "GET, PUT .zip, HEAD, DELETE" --> gw --> bucket
    fn -. "after 2 retries" .-> dlq["SQS failure queue"] --> alarm["CloudWatch alarm"]
```

For each `ObjectCreated` event the function:

1. Skips keys under the archive prefix (`archived/`), so the ZIP files it writes never loop, and skips empty folder markers.
2. Reads the object with `If-Match` on the ETag from the event, so it archives exactly the object the event describes. A missing or overwritten object means an earlier or newer event owns it.
3. Streams the object through a ZIP encoder straight into an S3 upload (multipart for large archives) at `archived/<original key>.zip`, using `If-None-Match: *` so an existing archive is never overwritten.
4. Confirms the stored archive with `HeadObject`.
5. Deletes the original with `If-Match` on its ETag, or by version ID in a versioned bucket, so a different object written to the same key in the meantime is never deleted.

If any step fails, the invocation fails. Lambda retries it twice and then sends the event to an SQS queue watched by an alarm. The original object stays in the bucket until its archive is confirmed.

## How the assessment tasks are covered

| Task | Requirement | Where |
| --- | --- | --- |
| 1 | Lambda built with AWS SAM, Node.js | [`template.yaml`](template.yaml) `ArchiverFunction`, [`src/archiver`](src/archiver) |
| 1 | Triggered by every new object | S3 `s3:ObjectCreated:*` event on the whole bucket |
| 1 | Compress to ZIP, upload to the same bucket | [`lib/zip-upload.mjs`](src/archiver/lib/zip-upload.mjs) |
| 1 | Delete the original after a successful upload | [`lib/handler.mjs`](src/archiver/lib/handler.mjs), after `HeadObject` confirms the archive |
| 2 | S3 bucket and Lambda wiring in one CloudFormation stack in `template.yaml` | [`template.yaml`](template.yaml) |
| 2 | Lambda in private subnets of a VPC defined in the same template | `Vpc`, `PrivateSubnetA/B`, `S3GatewayEndpoint`, `VpcConfig` |
| 2 | Dockerized Lambda | `PackageType: Image`, [`src/archiver/Dockerfile`](src/archiver/Dockerfile) |
| 2 | New version on each deployment, reliable rollback | `AutoPublishAlias: live`, `AutoPublishAliasAllProperties`, `AWS::LanguageExtensions`, `ReleaseId`, [`scripts/rollback.sh`](scripts/rollback.sh) |
| 3 | Incremental commits, README | `git log`, this file |
| 4 | Monthly cost at 1,000,000 files/hour, 10 MB each | [Cost analysis](#cost-analysis) |
| 5 | Scalability, cost efficiency and bottlenecks | [Scalability and bottlenecks](#scalability-and-bottlenecks) |

## Repository layout

```text
.
├── template.yaml                 # SAM/CloudFormation: VPC, bucket, function, alias, failure queue
├── samconfig.toml                # sam build/deploy defaults (stack name, region, ECR repo)
├── Makefile                      # install, lint, test, e2e, validate, build, deploy, rollback, delete
├── src/archiver/
│   ├── Dockerfile                # Lambda container image (public.ecr.aws/lambda/nodejs:24)
│   ├── app.mjs                   # Lambda entry point
│   ├── lib/
│   │   ├── handler.mjs           # event handling, safety checks, conditional delete
│   │   ├── zip-upload.mjs        # streaming S3 -> ZIP -> multipart upload with cleanup
│   │   ├── config.mjs            # environment validation
│   │   └── logger.mjs            # structured JSON logging
│   ├── tests/unit/               # node:test suites with a mocked S3 client
│   └── bench/compression.mjs     # compression ratio/CPU benchmark used for the cost model
├── scripts/
│   ├── e2e-local.sh              # runs the real image against a moto S3 server
│   ├── rollback.sh               # moves the live alias to an earlier version
│   └── cost-estimate.mjs         # reproducible monthly cost model
├── events/s3-object-created.json # sample S3 notification
└── .github/workflows/ci.yml      # lint, unit tests, template validation, e2e
```

## Design decisions

**Streaming instead of buffering.** The S3 response body is piped through `archiver` into `@aws-sdk/lib-storage`. Memory use is bounded by the upload buffer (by default four concurrent 5 MiB parts, ~20 MiB, plus compression and runtime overhead), not by the object size, and `/tmp` is not used, so the default memory and ephemeral storage settings handle objects far larger than 10 MB.

**Nothing is deleted or overwritten without proof.** S3 delivers events at least once, and Lambda retries asynchronous invocations, so every step is safe to repeat:

| Situation | Behaviour |
| --- | --- |
| Duplicate event after success | `GetObject` returns 404 and the record is skipped. `s3:ListBucket` is granted so S3 answers 404 instead of 403. |
| Retry after the archive was stored but the delete failed | The conditional upload returns 412. If the existing archive's `source-etag` metadata matches the source and its size equals the ZIP this attempt produced, it is reused and the source is deleted. |
| Key overwritten before it was read | `GetObject` with `If-Match` returns 412 and the record is skipped. The newer object's own event archives it. |
| Key overwritten with different content while archiving | The conditional `DeleteObject` returns 412 and the newer object is kept. |
| Archive key already holds another generation of the same key | The archive is written to `archived/<key>.<version-id or etag>.zip` instead of replacing it. If that key is also taken by a different generation, the invocation fails rather than overwrite anything. |
| Upload or source stream fails mid-way | The body stream is failed first, so a partial ZIP is never completed, and the multipart upload is aborted. A lifecycle rule also removes incomplete uploads after one day as a backstop. |
| Archive key would exceed S3's 1,024-byte limit | The archive goes to `archived/_long-keys/<sha256>.zip` and the full key is kept as the ZIP entry name. |

**No recursion.** The trigger covers the whole bucket, as the task describes, and archives land under `archived/`. The handler exits early for those keys without calling S3, and logs them at debug level. Setting `SourcePrefix=incoming/` narrows the trigger if uploads can be confined to a prefix; see the savings options.

**Private networking without a NAT gateway.** The VPC has two private subnets in different AZs and no internet or NAT gateway. The function reaches S3 through a gateway VPC endpoint, which has no hourly or data charge. At this workload a NAT gateway would add about $487,000 per month in data processing charges. The endpoint policy and the IAM role both only allow the archive bucket, and the security group allows no inbound traffic. Lambda ships logs and delivers failed events to SQS outside the function's network, so neither needs an endpoint.

**Versioned releases.** `AutoPublishAlias: live` publishes an immutable version and moves the alias, and the S3 notification invokes the alias.
- `AutoPublishAliasAllProperties` publishes a new version when any function setting changes, not only the image.
- `AWS::LanguageExtensions` resolves parameter values before SAM hashes the function. Without it, a parameter-only change would update `$LATEST` but leave the alias on stale configuration.
- `make deploy` passes `ReleaseId=<git sha>-<utc timestamp>`, so every deployment publishes a version labelled with its commit.

**Operations.**
- JSON logs with configurable retention. `SystemLogLevel: WARN` drops the per-invocation START/END/REPORT lines.
- A 14-day SQS failure queue for events that exhaust their retries, with an alarm (optionally wired to SNS) when it is not empty.
- The bucket is encrypted, blocks public access, enforces TLS, and is retained when the stack is deleted.

## Cost analysis

Scenario from the brief: **1,000,000 files per hour, 10 MB average**, which is 730 million files and about 7.3 PB (6.5 PiB) a month. All figures use on-demand prices for **ap-southeast-1 (Singapore)** from the AWS Price List API (September 2026 offer files). They are gross prices: Free Tier allowances, existing usage and retries are not deducted. The model is in [`scripts/cost-estimate.mjs`](scripts/cost-estimate.mjs); change its assumptions and re-run it to regenerate every table below.

Assumptions:

- **Compression ratio 4.69x (79% smaller).** Measured with [`bench/compression.mjs`](src/archiver/bench/compression.mjs) on synthetic video-analysis JSON (per-frame detections with float scores and bounding boxes). Real results can compress better or worse, so a sensitivity table is included.
- **0.713 s billed per archived file at 1,024 MB.** The benchmark's 185 ms compression time (inside the Lambda image, capped at the 0.58 vCPU a 1 GB function gets, on an Apple M5) is scaled ×2.5 for Graviton2, plus 0.25 s of S3 I/O. This is an estimate; replace it with the measured `Duration` after deployment.
- **The deployed configuration:** arm64, whole-bucket trigger (so each archive causes one extra, skipped invocation), INFO logs (one ~450-byte line per file), 14-day log retention, S3 Standard.
- **One S3 request of each kind per file:** GET, single-part PUT (a ~2 MB archive is below the 5 MiB multipart threshold), HEAD, and DELETE (free).

| Metric | Value |
| --- | --- |
| Files per month (1,000,000/h x 730 h) | 730,000,000 |
| Original data per month (10 MB each) | 6,798,655 GB (6.48 PiB) |
| Compression ratio (zlib level 6, benchmark) | 4.69x |
| Archived data per month | 1,449,607 GB (1.38 PiB) |
| Billed duration per archived file | 0.713 s at 1,024 MB |
| Invocations | 556/s (278/s archiving + 278/s skipped archive events) |
| Concurrent executions (steady state) | ~199 |

### Final estimate

- **Running the feature costs about $11,700 per month**, about $0.016 per 1,000 files. Lambda is about 62% of that and S3 requests about 36%.
- **It removes about $123,000 of S3 storage cost per month for every month of data kept**: one month of originals costs $156,932/month to store, one month of archives $33,904/month.
- **The bill is lower from the first month.** In month 1 (bucket starting empty) the total is **~$32,600 with the feature versus ~$82,400 without (−60%)**. By month 12 it is ~$399,000 versus ~$1,802,000 (−78%), because storage keeps accumulating.

### Monthly cost of running the feature

| Item | Calculation | USD / month |
| --- | --- | ---: |
| Lambda requests | 1,460 M invocations (archiving + skipped archive events) x $0.20 per M | $292 |
| Lambda compute (arm64, 1 GB) | (730 M x 0.713 s + 730 M x 0.005 s + 72,000 cold starts x 1.5 s) = 524.2 M GB-s x $0.0000133334 | $6,990 |
| S3 PUT (archive upload, conditional) | 730 M x $0.005 per 1,000 | $3,650 |
| S3 GET (read original) | 730 M x $0.0004 per 1,000 | $292 |
| S3 HEAD (verify stored archive) | 730 M x $0.0004 per 1,000 | $292 |
| S3 DELETE (conditional) | free | $0.00 |
| CloudWatch Logs ingestion (INFO) | 306 GB x $0.70 | $214 |
| CloudWatch Logs storage (14-day retention) | <= 141 GB x $0.03 | $4.22 |
| Alarm, ECR image (~0.3 GB), SQS failure queue | | $0.13 |
| VPC, S3 gateway endpoint, ENIs, S3 notifications, async queue, in-region transfer, SSE-S3 | free | $0.00 |
| **Total feature cost** | | **$11,735** |

### Storage impact

| | Without feature | With feature |
| --- | ---: | ---: |
| Data added per month | 6,798,655 GB | 1,449,607 GB |
| Storage cost of one month of data, per month kept | $156,932 | $33,904 |
| Upload PUTs from on-premises (unchanged) | $3,650 | $3,650 |

Total monthly bill for the bucket plus the feature, assuming the bucket starts empty and keeps everything:

| Month | Without feature | With feature | Difference |
| --- | ---: | ---: | ---: |
| 1 | $82,398 | $32,618 | -$49,780 (-60%) |
| 2 | $238,767 | $65,959 | -$172,808 (-72%) |
| 3 | $395,136 | $99,300 | -$295,836 (-75%) |
| 6 | $864,243 | $199,323 | -$664,920 (-77%) |
| 12 | $1,802,457 | $399,369 | -$1,403,089 (-78%) |

### Sensitivity

The estimate is most sensitive to Lambda duration (each additional 0.1 s per file adds ~$973/month) and, for storage, to the real compression ratio.

| Scenario | Feature cost / month |
| --- | ---: |
| Billed duration 0.5 s per archived file | $9,661 |
| Billed duration 1 s per archived file | $14,528 |
| Billed duration 1.5 s per archived file | $19,395 |
| Compression ratio 3x (storage of one month of archives: $52,686) | $11,735 |
| Compression ratio 8x (storage of one month of archives: $20,109) | $11,735 |

### Suggestions for saving more

| Option | Effect |
| --- | --- |
| ApplicationLogLevel=WARN | -$218 per month |
| SourcePrefix=incoming/ (archives no longer invoke the function) | -$195 per month |
| Compute Savings Plan (up to 17% of Lambda duration) | up to -$1,188 per month |
| ArchiveStorageClass=INTELLIGENT_TIERING | +$1,825 monitoring per month of data kept; each month of archives then saves $11,511/month after 30 days (Infrequent Access) and $24,268/month after 90 days (Archive Instant Access); no retrieval fees |
| ArchiveStorageClass=GLACIER_IR | +$17,958 per month in PUT/HEAD requests; each month of archives saves $26,093/month from day one; $0.03/GB and $0.01/1,000 GETs to read; 90-day minimum |
| Compression level 1 instead of 6 | -$2,122 per month compute, +$5,654/month storage per month of data kept (level 6 is cheaper once data is kept ~11 days) |
| Bundle 100 files per archive (S3 -> SQS -> Lambda batches) | about -$2,522 per month in requests and logs after 41-part uploads and SQS charges; compute not modelled |
| Compress on-premises before upload | -$11,735 per month (no function) and ~79% less upload bandwidth |
| Already avoided by design: NAT gateway for S3 traffic | $486,734 per month (8,248,261 GB processed + 2 gateways) |

In order of impact:

1. **Choose the storage class by access pattern. This is the biggest lever at this scale.** If archives are rarely read after the first weeks, deploy with `ArchiveStorageClass=INTELLIGENT_TIERING`. It adds no request or retrieval surcharges and moves untouched archives to $0.005/GB-month after 90 days, saving about $24,000 per month for each month of data kept. If archives are almost never read and kept for months, `GLACIER_IR` saves more per GB from day one. Its higher PUT and HEAD prices (+$18,000 a month) and 90-day minimum storage charge pay off only for data kept longer than about five weeks, and reads cost $0.03/GB. Add lifecycle expiration once a retention period is agreed.
2. **Compress on-premises before uploading.** This removes the function's ~$11,700 a month entirely and cuts upload bandwidth by about 79%. Upload bandwidth is also the main throughput constraint (see below).
3. **Bundle results** (many files per archive, per video or per batch). About $2,500 a month in fewer requests and logs, plus better compression across similar JSON documents.
4. **Buy a Compute Savings Plan** for the steady Lambda baseline: up to 17% of duration, about $1,200 a month.
5. **Run production with `ApplicationLogLevel=WARN`** (−$218) and, if uploads can be confined to a prefix, **`SourcePrefix=incoming/`** (−$195), which removes the extra invocation for each archive.
6. **Right-size memory** with [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) on real files. Every 100 ms saved per file is worth ~$973 a month. Keep compression level 6: level 1 saves ~$2,100 a month of compute but costs ~$5,700 a month more storage for every month of data kept.
7. **Keep S3 traffic on the gateway endpoint.** Routing it through NAT gateways instead would add roughly $487,000 a month in data processing charges; the template already avoids this.

## Scalability and bottlenecks

**Short answer:** yes, on paper. Nothing in the design has to change to handle 1,000,000 files per hour, and the storage savings far outweigh the running cost, provided the estimated duration and compression ratio hold. Capacity still needs a production-scale load test. The feature costs about $11,700 per month and cuts the storage bill by about $123,000 for every month of data retained. It is not the cheapest possible design at this volume, though: with one invocation and one archive per file, per-object request charges make up almost 40% of the feature cost, and several limits need to be raised or watched before production.

### Load at the target volume

| Dimension | Steady state | Limit / capacity | Headroom |
| --- | --- | --- | --- |
| Lambda invocations | 278/s archiving + 278/s skipped archive events | No invocation-rate quota for async S3 events | n/a |
| Lambda concurrency | ~200 (278/s x 0.71 s) | 1,000 per account and region by default, shared by every function; new accounts can start lower | ~5x at average load; a 3x hourly peak reaches ~600 |
| Lambda scale-up rate | | +1,000 concurrent executions every 10 s per function | Sufficient |
| S3 writes (ingest PUT + archive PUT + DELETE) | ~834/s | At least 3,500/s per partitioned prefix | ~4x per prefix |
| S3 reads (GET + HEAD) | ~556/s | At least 5,500/s per partitioned prefix | ~10x per prefix |
| VPC IP addresses | A few Hyperplane ENIs shared per subnet and security group | 8,187 IPs per /19 subnet; 65,000 connections per Hyperplane ENI | Not a constraint |
| Network to S3 | ~2.8 GB/s in from on-premises, ~3.4 GB/s via the gateway endpoint | Gateway endpoints have no throughput limit or charge | Not a constraint in AWS |

### Concerns and potential bottlenecks

1. **Account concurrency is shared.** About 200 steady executions, and roughly 600 at a 3x peak, sit on the default regional quota of 1,000 that every other function in the account also uses. If the quota is hit, S3 events are throttled and queued, Lambda retries them for up to 6 hours, and then they go to the failure queue. Before go-live, request a quota increase. Consider reserved concurrency to protect other workloads, and alarm on `Throttles`, `AsyncEventAge` and `AsyncEventsDropped`.
2. **S3 request rate per prefix.** About 834 writes per second on a bucket that also receives the uploads is within the documented per-prefix baseline, but S3 adds capacity by repartitioning gradually. Traffic concentrated on one prefix (for example a single date folder) or a sudden ramp-up can return `503 SlowDown`. The client retries with backoff (5 attempts), but sustained throttling adds latency and cost. Use high-cardinality key prefixes, for example `<yyyy>/<mm>/<dd>/<hh>/<hash>/...`.
3. **Upload bandwidth from on-premises is the real throughput bottleneck.** 1,000,000 x 10 MB per hour is about 22 Gbit/s sustained into S3, before this feature runs at all. Compressing on-premises would cut that to about 5 Gbit/s and make this function unnecessary.
4. **Duration grows with object size.** Compression is CPU-bound, at an estimated ~20 MiB/s at 1 GB. The average 10 MB file takes under a second, but a 1 GB file would approach the 60 s timeout. Raise `Timeout` and `MemorySize` if large outliers are expected. Objects that cannot finish within Lambda's 15-minute maximum (roughly 15 GB or more at this memory size), or ZIPs above the multipart limit of 10,000 × 5 MiB parts (~48 GiB), belong in AWS Batch or Fargate.
5. **One invocation and one archive per file.** 730 million invocations, GETs, PUTs and HEADs a month cost about $4,500 in request charges alone. Bundling files into one archive per batch (S3 → SQS → Lambda batch) or per video cuts invocations and per-archive requests. After multipart parts and SQS charges, the saving is about $2,500 a month for batches of 100. It also compresses better across similar JSON documents, at the price of more complex partial-failure handling.
6. **ZIP is a poor fit for "further analysis".** Athena, Glue and Spark read gzip, zstd and bzip2 natively, but not ZIP. Every analytics job would first have to extract the archives. If the archives feed analytics, `.json.gz` or `.json.zst` (or converting the results to Parquet) keeps them queryable in place.
7. **Event delivery is at least once, not exactly once.** Duplicates and overwrites are handled safely, but notifications can arrive late, S3 may send a single notification for two concurrent writes to the same key, and events that exhaust retries go to the failure queue. At 730 million events a month, even a tiny miss rate leaves originals behind. Add a daily reconciliation job driven by S3 Inventory (objects outside `archived/` older than a few hours), and a replay tool for the failure queue.
8. **Deployments cause a burst of cold starts.** Moving the alias to a new version starts new execution environments for all ~200 concurrent requests at once. Container images are cached, so this mostly means a short latency spike. For safer releases, add `DeploymentPreference` (CodeDeploy canary or linear traffic shifting) with the error alarm as an automatic rollback trigger.
9. **Single region.** A regional S3 or Lambda disruption pauses archiving. Originals stay in place, events are retried for up to 6 hours and then kept in the failure queue for 14 days. The replay and reconciliation tooling from item 7 is not part of this repository and would be needed to catch up reliably.
10. **Log volume.** At `INFO`, one line per file is about 306 GB of CloudWatch Logs a month. Run production at `WARN` and rely on metrics, keeping `INFO` for troubleshooting.

### Verdict

The architecture holds up at this scale: it is serverless and stateless, the gateway endpoint removes the network bottleneck, and the processing path is idempotent. Before production, raise the Lambda concurrency quota, use distributed key prefixes, add alarms and a reconciliation job, and right-size memory with [AWS Lambda Power Tuning](https://github.com/alexcasalboni/aws-lambda-power-tuning) against real files. For the lowest total cost at 1,000,000 files per hour, the better long-term design compresses at the source, or batches many results per archive, in a format analytics tools can read directly (gzip/zstd).

## Local development and testing

Prerequisites: Node.js 24, Docker, AWS CLI v2, [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), `cfn-lint`, and Python 3, curl and jq (for the e2e test).

```bash
make install    # npm ci in src/archiver
make lint       # ESLint + cfn-lint
make test       # unit tests (node:test, mocked S3)
make e2e        # real container image + Lambda Runtime Interface Emulator + moto S3
make validate   # sam validate --lint
make build      # sam build (container image)
```

The unit tests cover the safety cases above: conditional operations, archive reuse and generation conflicts, multipart abort on failure, long keys and duplicate deliveries. The e2e test builds the actual image and verifies ZIP contents byte for byte against moto for JSON, Unicode keys and a multipart-sized object, including a replayed event. CI runs lint, unit tests, template validation and the e2e test on pushes and pull requests to `main`.

Measure compression for the cost model inside the Lambda image. `--cpus 0.58` matches the CPU share of a 1,024 MB function:

```bash
make build
docker run --rm --cpus 0.58 --entrypoint node \
  -v "$PWD/src/archiver/bench:/var/task/bench:ro" \
  archiverfunction:nodejs24 /var/task/bench/compression.mjs
node scripts/cost-estimate.mjs   # regenerate the cost tables
```

## Deployment

The stack has no hourly charges: there is no NAT gateway or interface endpoint, and the S3 gateway endpoint is free. A small test deployment is typically covered by Free Tier allowances or credits, depending on the account. Charges come only from usage (Lambda, S3, CloudWatch Logs) plus a few cents of ECR image storage and one CloudWatch alarm.

```bash
aws configure                      # or export AWS_PROFILE=...
make deploy                        # sam build + sam deploy, region ap-southeast-1 by default
make deploy AWS_REGION=us-east-1   # another region
```

`sam deploy` creates an ECR repository for the image on first use, shows the change set and asks for confirmation. Stack parameters can be overridden, for example:

```bash
make deploy PARAMETER_OVERRIDES="ApplicationLogLevel=WARN SourcePrefix=incoming/ ArchiveStorageClass=GLACIER_IR"
```

Try it with the default parameters (whole-bucket trigger, INFO logs):

```bash
export AWS_REGION=ap-southeast-1   # the region you deployed to
BUCKET=$(aws cloudformation describe-stacks --stack-name s3-zip-archiver \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
echo '{"videoId":"v-1","frames":[{"t":0,"labels":["person"]}]}' > result.json
aws s3 cp result.json "s3://$BUCKET/2026/09/17/result.json"
aws logs tail /aws/lambda/s3-zip-archiver-archiver --follow   # "Archived object"
aws s3 ls "s3://$BUCKET" --recursive                          # archived/2026/09/17/result.json.zip
```

## Rollback

Each deployment publishes a numbered version labelled `release <git sha>-<timestamp>`, and the S3 trigger always invokes the `live` alias.

```bash
make rollback                    # list versions, their release labels and the current alias target
make rollback VERSION=previous   # point live at the version before the current one
make rollback VERSION=7          # point live at a specific version
```

Moving the alias takes effect for the next invocation, with no rebuild. CloudFormation still owns the alias, so make the rollback permanent by reverting the faulty commit and running `make deploy`, which publishes a new version from the reverted code. Keep old images in ECR: an image-based version cannot run once its image is deleted, so any ECR lifecycle policy must keep images for the versions you may roll back to.

## Teardown

```bash
make delete
```

The bucket is retained on purpose so archived data survives stack deletion. Delete it explicitly when you no longer need it (`aws s3 rb "s3://$BUCKET" --force`). Deleting a VPC-attached function can take a while, because Lambda releases its network interfaces asynchronously.
