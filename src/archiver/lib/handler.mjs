import { createHash } from "node:crypto";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { logger as defaultLogger } from "./logger.mjs";
import { isPreconditionFailed, uploadZipArchive } from "./zip-upload.mjs";

const MAX_KEY_BYTES = 1024;

/**
 * Builds the Lambda handler. Dependencies are injected so the handler can be
 * exercised with a mocked S3 client in tests.
 */
export function createHandler({ s3, config, logger = defaultLogger }) {
  return async function handler(event) {
    const records = event?.Records ?? [];
    const settled = await Promise.allSettled(
      records.map((record) => processRecord({ s3, config, logger, record })),
    );

    const results = [];
    const errors = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        errors.push(outcome.reason);
        logger.error("Failed to archive object", { error: describeError(outcome.reason) });
      }
    }

    // Throwing makes Lambda retry the async invocation and, once retries are
    // exhausted, route the event to the on-failure destination. Records that
    // already succeeded are skipped on retry because their source is gone.
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} of ${records.length} object(s) failed to archive`);
    }
    return { results };
  };
}

export async function processRecord({ s3, config, logger, record }) {
  const { bucket, key, eTag, versionId, size } = parseS3Record(record);
  const skip = (reason, level = "info") => {
    logger[level]("Skipping object", { bucket, key, reason });
    return { status: "skipped", bucket, key, reason };
  };

  // Expected once per archive when the trigger covers the whole bucket, so it
  // is logged at debug level to keep CloudWatch ingestion flat.
  if (key.startsWith(config.archivePrefix)) return skip("already-archived", "debug");
  if (!key.startsWith(config.sourcePrefix)) return skip("outside-source-prefix");
  if (key.endsWith("/") && size === 0) return skip("folder-placeholder");

  const startedAt = Date.now();

  // The canonical archive key is tried first. If it already holds an archive
  // of a different source generation (the key was overwritten and archived
  // before), the archive is written under a generation-specific key instead,
  // so no archived content is ever replaced.
  let archived;
  for (const target of archiveTargets(key, versionId ?? eTag, config)) {
    archived = await archiveTo({ s3, bucket, key, eTag, versionId, config, target });
    if (archived.status !== "conflict") break;
    logger.warn("Archive key holds another source generation", { bucket, key, archiveKey: target.archiveKey });
  }
  if (archived.status === "skipped") return skip(archived.reason);
  if (archived.status === "conflict") {
    throw new Error(`Every archive key for s3://${bucket}/${key} holds a different source generation`);
  }

  const sourceDeleted = await deleteSource({ s3, bucket, key, eTag, versionId, logger });

  const result = {
    status: "archived",
    bucket,
    key,
    archiveKey: archived.archiveKey,
    sourceDeleted,
    sourceBytes: archived.sourceBytes,
    archiveBytes: archived.archiveBytes,
    durationMs: Date.now() - startedAt,
  };
  logger.info("Archived object", result);
  return result;
}

async function archiveTo({ s3, bucket, key, eTag, versionId, config, target }) {
  // Pin the read to the exact object the event describes. If it was deleted
  // (already archived by an earlier delivery) or overwritten, a newer event
  // owns it, so there is nothing left to do here.
  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, IfMatch: quoteETag(eTag) }),
    );
  } catch (err) {
    if (isNotFound(err)) return { status: "skipped", reason: "source-not-found" };
    if (isPreconditionFailed(err)) return { status: "skipped", reason: "source-changed" };
    throw err;
  }

  const sourceETag = stripQuotes(object.ETag ?? eTag ?? "");
  const { bytes, created } = await uploadZipArchive({
    s3,
    source: object.Body,
    entryName: target.entryName,
    entryDate: object.LastModified,
    bucket,
    key: target.archiveKey,
    compressionLevel: config.compressionLevel,
    storageClass: config.storageClass,
    // User metadata is limited to 2 KB, so only bounded values are stored;
    // the full source key is recoverable from the archive key or entry name.
    metadata: {
      "source-etag": sourceETag,
      "source-size": String(object.ContentLength ?? ""),
    },
  });

  // Only remove the original once S3 confirms a complete archive of this
  // exact source exists. An existing archive counts only if it was produced
  // from the same source ETag and has the size this run just produced
  // (the output is deterministic for the same input and settings).
  const stored = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: target.archiveKey }));
  if (!created && (stored.Metadata?.["source-etag"] !== sourceETag || stored.ContentLength !== bytes)) {
    return { status: "conflict" };
  }
  if (stored.ContentLength !== bytes) {
    throw new Error(
      `Archive s3://${bucket}/${target.archiveKey} has ${stored.ContentLength} bytes, expected ${bytes}; keeping source`,
    );
  }

  return { status: "archived", archiveKey: target.archiveKey, sourceBytes: object.ContentLength, archiveBytes: bytes };
}

async function deleteSource({ s3, bucket, key, eTag, versionId, logger }) {
  try {
    // Versioned bucket: permanently remove exactly the archived version.
    // Otherwise the delete is conditional on the ETag, so an object written to
    // the same key while archiving is kept for its own event to archive.
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
        IfMatch: versionId ? undefined : quoteETag(eTag),
      }),
    );
    return true;
  } catch (err) {
    if (isNotFound(err)) return true;
    if (isPreconditionFailed(err)) {
      logger.warn("Source changed after archiving; keeping the newer object", { bucket, key });
      return false;
    }
    throw err;
  }
}

export function parseS3Record(record) {
  const s3 = record?.s3;
  if (!s3?.bucket?.name || typeof s3?.object?.key !== "string") {
    throw new Error("Event record is not an S3 notification");
  }
  return {
    bucket: s3.bucket.name,
    // S3 URL-encodes keys in notifications and encodes spaces as "+".
    key: decodeURIComponent(s3.object.key.replace(/\+/g, " ")),
    eTag: s3.object.eTag,
    versionId: s3.object.versionId,
    size: s3.object.size,
  };
}

/**
 * Candidate archive locations for a source key, in order of preference: the
 * canonical key, then a key qualified with the source generation. Keys that
 * would exceed S3's 1,024-byte limit are replaced by a hash of the source key,
 * and the entry inside the ZIP keeps the full key.
 */
export function archiveTargets(key, generation, { sourcePrefix, archivePrefix }) {
  const relative = key.slice(sourcePrefix.length);
  const suffix = generation ? `.${generation.replace(/[^A-Za-z0-9_-]/g, "")}` : "";

  let base = `${archivePrefix}${relative}`;
  let entryName = path.posix.basename(key);
  if (Buffer.byteLength(`${base}${suffix}.zip`) > MAX_KEY_BYTES) {
    base = `${archivePrefix}_long-keys/${createHash("sha256").update(key).digest("hex")}`;
    entryName = key;
  }

  const targets = [{ archiveKey: `${base}.zip`, entryName }];
  if (suffix) targets.push({ archiveKey: `${base}${suffix}.zip`, entryName });
  return targets;
}

function quoteETag(eTag) {
  return eTag ? `"${stripQuotes(eTag)}"` : undefined;
}

function stripQuotes(value) {
  return value.replace(/^"|"$/g, "");
}

function isNotFound(err) {
  return err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;
}

function describeError(err) {
  return { name: err?.name, message: err?.message };
}
