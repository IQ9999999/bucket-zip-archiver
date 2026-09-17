import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { beforeEach, describe, it } from "node:test";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import { mockClient } from "aws-sdk-client-mock";
import { loadConfig } from "../../lib/config.mjs";
import { archiveTargets, createHandler, parseS3Record } from "../../lib/handler.mjs";

const BUCKET = "media-results";
const ETAG = "0123456789abcdef";
const SOURCE_KEY = "2026/09/result.json";
const ARCHIVE_KEY = "archived/2026/09/result.json.zip";
const LAST_MODIFIED = new Date("2026-09-01T10:00:00Z");
const silentLogger = { info() {}, warn() {}, error() {} };

const s3 = new S3Client({ region: "ap-southeast-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const s3Mock = mockClient(s3);
const handler = createHandler({ s3, config: loadConfig({}), logger: silentLogger });

function s3Event(key, { eTag = ETAG, versionId, size = 1 } = {}) {
  return {
    Records: [
      {
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        s3: { bucket: { name: BUCKET }, object: { key, eTag, versionId, size } },
      },
    ],
  };
}

function s3Error(name, httpStatusCode) {
  return new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode } });
}

/**
 * Mocks an S3 bucket holding `content` at SOURCE_KEY. Uploaded archives are
 * captured per key and HeadObject reports what was stored.
 */
function mockBucket(content, { body = () => Readable.from([content]) } = {}) {
  const stored = new Map();
  const parts = [];

  s3Mock.on(GetObjectCommand).callsFake(() => ({
    Body: body(),
    ContentLength: content.length,
    ETag: `"${ETAG}"`,
    LastModified: LAST_MODIFIED,
  }));
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (stored.has(input.Key) && input.IfNoneMatch === "*") throw s3Error("PreconditionFailed", 412);
    stored.set(input.Key, { body: Buffer.from(input.Body), metadata: input.Metadata, input });
    return { ETag: '"archive"' };
  });
  s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
  s3Mock.on(UploadPartCommand).callsFake((input) => {
    parts[input.PartNumber - 1] = Buffer.from(input.Body);
    return { ETag: `"part-${input.PartNumber}"` };
  });
  s3Mock.on(CompleteMultipartUploadCommand).callsFake((input) => {
    stored.set(input.Key, { body: Buffer.concat(parts), metadata: input.Metadata, input });
    return { ETag: '"archive-mpu"' };
  });
  s3Mock.on(AbortMultipartUploadCommand).resolves({});
  s3Mock.on(HeadObjectCommand).callsFake(({ Key }) => {
    const object = stored.get(Key);
    if (!object) throw s3Error("NotFound", 404);
    return { ContentLength: object.body.length, Metadata: object.metadata };
  });
  s3Mock.on(DeleteObjectCommand).resolves({});
  return stored;
}

function readZip(buffer) {
  return new AdmZip(buffer).getEntries().map((entry) => ({ name: entry.entryName, data: entry.getData() }));
}

beforeEach(() => {
  s3Mock.reset();
});

describe("parseS3Record", () => {
  it("decodes URL-encoded keys from S3 notifications", () => {
    const { key } = parseS3Record(s3Event("video+results/r%C3%A9sum%C3%A9%2B1.json").Records[0]);
    assert.equal(key, "video results/résumé+1.json");
  });

  it("rejects records that are not S3 notifications", () => {
    assert.throws(() => parseS3Record({ eventSource: "aws:sqs" }), /not an S3 notification/);
  });
});

describe("archiveTargets", () => {
  const config = { sourcePrefix: "incoming/", archivePrefix: "archived/" };

  it("maps the source prefix onto the archive prefix, then a generation-specific key", () => {
    assert.deepEqual(archiveTargets("incoming/a/b.json", '"abc-2"', config), [
      { archiveKey: "archived/a/b.json.zip", entryName: "b.json" },
      { archiveKey: "archived/a/b.json.abc-2.zip", entryName: "b.json" },
    ]);
  });

  it("hashes keys that would exceed the 1,024-byte S3 key limit and keeps the full key in the ZIP", () => {
    const key = `incoming/${"界".repeat(338)}`; // 1,023 bytes
    const [canonical, generation] = archiveTargets(key, ETAG, config);
    assert.match(canonical.archiveKey, /^archived\/_long-keys\/[0-9a-f]{64}\.zip$/);
    assert.equal(generation.archiveKey, canonical.archiveKey.replace(/\.zip$/, `.${ETAG}.zip`));
    assert.equal(canonical.entryName, key);
  });
});

describe("handler", () => {
  it("zips the object, uploads it and deletes the original", async () => {
    const content = Buffer.from(JSON.stringify({ videoId: "v-1", frames: Array(500).fill({ score: 0.97 }) }));
    const stored = mockBucket(content);

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].status, "archived");
    assert.equal(results[0].archiveKey, ARCHIVE_KEY);
    assert.equal(results[0].sourceDeleted, true);
    assert.ok(results[0].archiveBytes < content.length, "archive should be smaller than the JSON source");

    const [get] = s3Mock.commandCalls(GetObjectCommand);
    assert.equal(get.args[0].input.IfMatch, `"${ETAG}"`);

    const archive = stored.get(ARCHIVE_KEY);
    assert.equal(archive.input.Bucket, BUCKET);
    assert.equal(archive.input.ContentType, "application/zip");
    assert.equal(archive.input.StorageClass, "STANDARD");
    assert.equal(archive.input.IfNoneMatch, "*", "archives must never overwrite existing objects");
    assert.deepEqual(archive.metadata, { "source-etag": ETAG, "source-size": String(content.length) });

    const entries = readZip(archive.body);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "result.json");
    assert.deepEqual(entries[0].data, content);

    const [del] = s3Mock.commandCalls(DeleteObjectCommand);
    assert.deepEqual(del.args[0].input, { Bucket: BUCKET, Key: SOURCE_KEY, VersionId: undefined, IfMatch: `"${ETAG}"` });
  });

  it("uses multipart upload for archives larger than one part", async () => {
    const content = randomBytes(6 * 1024 * 1024); // incompressible, so the ZIP exceeds 5 MiB
    const stored = mockBucket(content);

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].status, "archived");
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
    assert.ok(s3Mock.commandCalls(UploadPartCommand).length >= 2);
    assert.equal(s3Mock.commandCalls(CompleteMultipartUploadCommand)[0].args[0].input.IfNoneMatch, "*");
    assert.deepEqual(readZip(stored.get(ARCHIVE_KEY).body)[0].data, content);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
  });

  for (const [key, reason, size] of [
    ["archived/2026/09/result.json.zip", "already-archived", 10],
    ["2026/09/", "folder-placeholder", 0],
  ]) {
    it(`skips ${key} (${reason}) without touching S3`, async () => {
      const { results } = await handler(s3Event(key, { size }));
      assert.deepEqual(results, [{ status: "skipped", bucket: BUCKET, key, reason }]);
      assert.equal(s3Mock.calls().length, 0);
    });
  }

  it("only processes keys under a configured source prefix", async () => {
    const scoped = createHandler({ s3, config: loadConfig({ SOURCE_PREFIX: "incoming/" }), logger: silentLogger });
    const { results } = await scoped(s3Event("other/result.json"));
    assert.equal(results[0].reason, "outside-source-prefix");
    assert.equal(s3Mock.calls().length, 0);
  });

  it("archives non-empty objects whose key ends with a slash", async () => {
    mockBucket(Buffer.from("{}"));
    const { results } = await handler(s3Event("odd-key/", { size: 2 }));
    assert.equal(results[0].status, "archived");
  });

  it("treats a missing source as already archived (duplicate delivery)", async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error("NoSuchKey", 404));

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].reason, "source-not-found");
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("skips a source that was overwritten after the event was sent", async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error("PreconditionFailed", 412));

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].reason, "source-changed");
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("finishes a delivery whose archive was stored but whose source was not deleted", async () => {
    const stored = mockBucket(Buffer.from("{}"));
    await handler(s3Event(SOURCE_KEY));
    const firstArchive = stored.get(ARCHIVE_KEY).body;
    s3Mock.resetHistory();

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].status, "archived");
    assert.equal(results[0].archiveKey, ARCHIVE_KEY);
    assert.equal(stored.get(ARCHIVE_KEY).body, firstArchive, "existing archive must not be replaced");
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
  });

  it("writes a generation-specific archive instead of replacing another generation's archive", async () => {
    const stored = mockBucket(Buffer.from('{"generation":2}'));
    stored.set(ARCHIVE_KEY, { body: Buffer.from("older archive"), metadata: { "source-etag": "older" } });

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].archiveKey, `archived/2026/09/result.json.${ETAG}.zip`);
    assert.deepEqual(stored.get(ARCHIVE_KEY).body, Buffer.from("older archive"));
    assert.deepEqual(readZip(stored.get(results[0].archiveKey).body)[0].data, Buffer.from('{"generation":2}'));
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
  });

  it("keeps the source when the key is overwritten while archiving", async () => {
    mockBucket(Buffer.from("{}"));
    s3Mock.on(DeleteObjectCommand).rejects(s3Error("PreconditionFailed", 412));

    const { results } = await handler(s3Event(SOURCE_KEY));

    assert.equal(results[0].status, "archived");
    assert.equal(results[0].sourceDeleted, false);
  });

  it("does not delete the source if the stored archive size does not match", async () => {
    mockBucket(Buffer.from("{}"));
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1 });

    await assert.rejects(handler(s3Event(SOURCE_KEY)), AggregateError);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("does not delete the source if the upload fails", async () => {
    mockBucket(Buffer.from("{}"));
    s3Mock.on(PutObjectCommand).rejects(s3Error("SlowDown", 503));

    await assert.rejects(handler(s3Event(SOURCE_KEY)), AggregateError);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("aborts the multipart upload when completing it fails", async () => {
    mockBucket(randomBytes(6 * 1024 * 1024));
    s3Mock.on(CompleteMultipartUploadCommand).rejects(s3Error("InternalError", 500));

    await assert.rejects(handler(s3Event(SOURCE_KEY)), AggregateError);
    assert.deepEqual(s3Mock.commandCalls(AbortMultipartUploadCommand)[0].args[0].input, {
      Bucket: BUCKET,
      Key: ARCHIVE_KEY,
      UploadId: "upload-1",
    });
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("aborts the multipart upload and fails when the source stream breaks", async () => {
    const source = new PassThrough();
    mockBucket(Buffer.alloc(0), { body: () => source });
    // Break the download once the first part has been uploaded, like a
    // connection reset halfway through a large object.
    s3Mock.on(UploadPartCommand).callsFake(() => {
      setImmediate(() => source.destroy(new Error("connection reset")));
      return { ETag: '"part-1"' };
    });
    source.write(randomBytes(12 * 1024 * 1024));

    await assert.rejects(handler(s3Event(SOURCE_KEY)), (err) => {
      assert.match(err.errors[0].message, /connection reset/);
      return true;
    });
    assert.ok(s3Mock.commandCalls(AbortMultipartUploadCommand).length >= 1);
    assert.equal(s3Mock.commandCalls(CompleteMultipartUploadCommand).length, 0);
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0, "a partial archive must never be stored");
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("deletes the exact archived version in versioned buckets", async () => {
    const stored = mockBucket(Buffer.from("{}"));
    stored.set(ARCHIVE_KEY, { body: Buffer.from("other"), metadata: { "source-etag": "other" } });

    const { results } = await handler(s3Event(SOURCE_KEY, { versionId: "v42" }));

    assert.equal(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.VersionId, "v42");
    assert.equal(results[0].archiveKey, "archived/2026/09/result.json.v42.zip");
    const [del] = s3Mock.commandCalls(DeleteObjectCommand);
    assert.equal(del.args[0].input.VersionId, "v42");
    assert.equal(del.args[0].input.IfMatch, undefined);
  });

  it("fails the invocation when any record fails so Lambda can retry", async () => {
    mockBucket(Buffer.from("{}"));
    const event = s3Event(SOURCE_KEY);
    event.Records.push(s3Event("2026/09/denied.json").Records[0]);
    s3Mock.on(GetObjectCommand, { Key: "2026/09/denied.json" }).rejects(s3Error("AccessDenied", 403));

    await assert.rejects(handler(event), (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.errors.length, 1);
      assert.match(err.message, /1 of 2/);
      return true;
    });
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
  });

  it("ignores events without records such as the s3:TestEvent", async () => {
    assert.deepEqual(await handler({ Event: "s3:TestEvent" }), { results: [] });
  });
});
