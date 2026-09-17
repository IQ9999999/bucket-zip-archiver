import { PassThrough } from "node:stream";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { ZipArchive } from "archiver";

/**
 * Streams `source` into a single-entry ZIP archive and uploads it to S3.
 *
 * Nothing is buffered beyond the multipart part size, so memory usage stays
 * flat regardless of the object size. The upload is conditional
 * (If-None-Match: *), so an existing archive is never overwritten.
 *
 * @returns {Promise<{ bytes: number, created: boolean }>} archive size, and
 *   `created: false` when an object already existed at `key`
 */
export async function uploadZipArchive({
  s3,
  source,
  entryName,
  entryDate,
  bucket,
  key,
  compressionLevel,
  storageClass,
  metadata,
}) {
  const archive = new ZipArchive({ zlib: { level: compressionLevel } });
  const output = new PassThrough();

  // Archiver reports some source problems as warnings; for a single-entry
  // archive any of them means the ZIP would be incomplete, so treat as fatal.
  const failed = new Promise((_, reject) => {
    archive.once("error", reject);
    archive.once("warning", reject);
    source.once("error", reject);
  });
  failed.catch(() => {});

  archive.pipe(output);
  archive.append(source, { name: entryName, date: entryDate });

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: output,
      ContentType: "application/zip",
      StorageClass: storageClass,
      Metadata: metadata,
      IfNoneMatch: "*",
    },
  });
  const uploading = upload.done();

  try {
    await Promise.race([Promise.all([uploading, archive.finalize()]), failed]);
    return { bytes: archive.pointer(), created: true };
  } catch (err) {
    // Fail the body stream before stopping the archiver, so a partial ZIP can
    // never reach the end of the stream and be completed as an object.
    output.destroy(err);
    archive.unpipe(output);
    archive.abort();
    source.destroy?.();

    // lib-storage aborts the multipart upload once its input fails; wait for
    // that instead of letting cleanup race the end of the invocation.
    await uploading.catch(() => {});
    // It does not clean up when CompleteMultipartUpload itself fails.
    if (upload.uploadId) {
      await s3
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: upload.uploadId }))
        .catch(() => {});
    }

    if (isPreconditionFailed(err)) {
      return { bytes: archive.pointer(), created: false };
    }
    throw err;
  }
}

export function isPreconditionFailed(err) {
  return err?.name === "PreconditionFailed" || err?.$metadata?.httpStatusCode === 412;
}
