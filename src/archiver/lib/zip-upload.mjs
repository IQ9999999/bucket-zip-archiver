import { PassThrough } from "node:stream";
import { Upload } from "@aws-sdk/lib-storage";
import { ZipArchive } from "archiver";

/**
 * Streams `source` into a single-entry ZIP archive and uploads it to S3.
 *
 * Nothing is buffered beyond the multipart part size, so memory usage stays
 * flat regardless of the object size. Larger archives are uploaded with S3
 * multipart upload, which lib-storage aborts if anything fails.
 *
 * @returns {Promise<{ bytes: number }>} size of the uploaded archive
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
    },
  });

  try {
    await Promise.race([Promise.all([upload.done(), archive.finalize()]), failed]);
  } catch (err) {
    archive.abort();
    source.destroy?.();
    await upload.abort().catch(() => {});
    throw err;
  }

  return { bytes: archive.pointer() };
}
