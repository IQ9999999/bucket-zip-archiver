import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { logger as defaultLogger } from "./logger.mjs";
import { uploadZipArchive } from "./zip-upload.mjs";

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
  const { bucket, key, eTag, versionId } = parseS3Record(record);
  const skip = (reason) => {
    logger.info("Skipping object", { bucket, key, reason });
    return { status: "skipped", bucket, key, reason };
  };

  if (key.startsWith(config.archivePrefix)) return skip("already-archived");
  if (!key.startsWith(config.sourcePrefix)) return skip("outside-source-prefix");
  if (key.endsWith("/")) return skip("folder-placeholder");

  const startedAt = Date.now();
  const archiveKey = archiveKeyFor(key, config);

  // Pin the read to the exact object the event describes. If it was deleted
  // (already archived by an earlier delivery) or overwritten, a newer event
  // owns it, so there is nothing left to do here.
  let object;
  try {
    object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId, IfMatch: quoteETag(eTag) }),
    );
  } catch (err) {
    if (isNotFound(err)) return skip("source-not-found");
    if (isPreconditionFailed(err)) return skip("source-changed");
    throw err;
  }

  const { bytes: archiveBytes } = await uploadZipArchive({
    s3,
    source: object.Body,
    entryName: path.posix.basename(key),
    entryDate: object.LastModified,
    bucket,
    key: archiveKey,
    compressionLevel: config.compressionLevel,
    storageClass: config.storageClass,
    metadata: {
      "source-key": encodeURIComponent(key),
      "source-etag": stripQuotes(object.ETag ?? eTag ?? ""),
      "source-size": String(object.ContentLength ?? ""),
    },
  });

  // Only remove the original once S3 confirms the complete archive exists.
  const stored = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: archiveKey }));
  if (stored.ContentLength !== archiveBytes) {
    throw new Error(
      `Archive s3://${bucket}/${archiveKey} has ${stored.ContentLength} bytes, expected ${archiveBytes}; keeping source`,
    );
  }

  const sourceDeleted = await deleteSource({ s3, bucket, key, eTag, versionId, logger });

  const result = {
    status: "archived",
    bucket,
    key,
    archiveKey,
    sourceDeleted,
    sourceBytes: object.ContentLength,
    archiveBytes,
    durationMs: Date.now() - startedAt,
  };
  logger.info("Archived object", result);
  return result;
}

async function deleteSource({ s3, bucket, key, eTag, versionId, logger }) {
  if (!versionId) {
    // Unversioned bucket: make sure the key still holds the object we archived
    // so a concurrent overwrite is not deleted before it gets archived itself.
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, IfMatch: quoteETag(eTag) }));
    } catch (err) {
      if (isNotFound(err)) return true;
      if (isPreconditionFailed(err)) {
        logger.warn("Source changed after archiving; keeping the newer object", { bucket, key });
        return false;
      }
      throw err;
    }
  }

  // With a version ID this permanently removes exactly the archived version.
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  return true;
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
  };
}

export function archiveKeyFor(key, { sourcePrefix, archivePrefix }) {
  return `${archivePrefix}${key.slice(sourcePrefix.length)}.zip`;
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

function isPreconditionFailed(err) {
  return err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}

function describeError(err) {
  return { name: err?.name, message: err?.message };
}
