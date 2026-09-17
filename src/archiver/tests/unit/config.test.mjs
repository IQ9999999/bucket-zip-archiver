import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../lib/config.mjs";

describe("loadConfig", () => {
  it("applies defaults", () => {
    assert.deepEqual(loadConfig({}), {
      sourcePrefix: "incoming/",
      archivePrefix: "archived/",
      compressionLevel: 6,
      storageClass: "STANDARD",
    });
  });

  it("reads values from the environment", () => {
    const config = loadConfig({
      SOURCE_PREFIX: "exports/",
      ARCHIVE_PREFIX: "zipped/",
      COMPRESSION_LEVEL: "9",
      ARCHIVE_STORAGE_CLASS: "GLACIER_IR",
    });
    assert.deepEqual(config, {
      sourcePrefix: "exports/",
      archivePrefix: "zipped/",
      compressionLevel: 9,
      storageClass: "GLACIER_IR",
    });
  });

  it("rejects an archive prefix that would re-trigger the function", () => {
    assert.throws(() => loadConfig({ SOURCE_PREFIX: "data/", ARCHIVE_PREFIX: "data/" }), /must differ/);
    assert.throws(() => loadConfig({ ARCHIVE_PREFIX: "" }), /must not be empty/);
  });

  it("rejects invalid compression levels and storage classes", () => {
    assert.throws(() => loadConfig({ COMPRESSION_LEVEL: "10" }), /COMPRESSION_LEVEL/);
    assert.throws(() => loadConfig({ COMPRESSION_LEVEL: "fast" }), /COMPRESSION_LEVEL/);
    assert.throws(() => loadConfig({ ARCHIVE_STORAGE_CLASS: "COLD" }), /ARCHIVE_STORAGE_CLASS/);
  });
});
