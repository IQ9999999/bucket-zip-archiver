const STORAGE_CLASSES = new Set([
  "STANDARD",
  "STANDARD_IA",
  "ONEZONE_IA",
  "INTELLIGENT_TIERING",
  "GLACIER_IR",
  "GLACIER",
  "DEEP_ARCHIVE",
]);

/**
 * Reads and validates the function configuration from environment variables.
 * Throws during cold start so a misconfigured deployment fails loudly instead
 * of silently deleting or skipping objects.
 */
export function loadConfig(env = process.env) {
  // An empty source prefix archives every new object in the bucket.
  const sourcePrefix = env.SOURCE_PREFIX ?? "";
  const archivePrefix = env.ARCHIVE_PREFIX ?? "archived/";
  const compressionLevel = Number(env.COMPRESSION_LEVEL ?? 6);
  const storageClass = env.ARCHIVE_STORAGE_CLASS ?? "STANDARD";

  if (!archivePrefix) {
    throw new Error("ARCHIVE_PREFIX must not be empty");
  }
  // Keys under the archive prefix are always skipped, so a source prefix
  // inside it would silently skip every object.
  if (sourcePrefix.startsWith(archivePrefix)) {
    throw new Error("SOURCE_PREFIX must not be inside ARCHIVE_PREFIX; every object would be skipped");
  }
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw new Error(`COMPRESSION_LEVEL must be an integer between 0 and 9, got "${env.COMPRESSION_LEVEL}"`);
  }
  if (!STORAGE_CLASSES.has(storageClass)) {
    throw new Error(`ARCHIVE_STORAGE_CLASS "${storageClass}" is not supported`);
  }

  return Object.freeze({ sourcePrefix, archivePrefix, compressionLevel, storageClass });
}
