import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, it } from "node:test";
import {
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
import { archiveKeyFor, createHandler, parseS3Record } from "../../lib/handler.mjs";

const BUCKET = "media-results";
const ETAG = "0123456789abcdef";
const LAST_MODIFIED = new Date("2026-09-01T10:00:00Z");
const silentLogger = { info() {}, warn() {}, error() {} };

const s3 = new S3Client({ region: "ap-southeast-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const s3Mock = mockClient(s3);
const handler = createHandler({ s3, config: loadConfig({}), logger: silentLogger });

function s3Event(key, { eTag = ETAG, versionId } = {}) {
  return {
    Records: [
      {
        eventSource: "aws:s3",
        eventName: "ObjectCreated:Put",
        s3: { bucket: { name: BUCKET }, object: { key, eTag, versionId } },
      },
    ],
  };
}

function s3Error(name, httpStatusCode) {
  return new S3ServiceException({ name, $fault: "client", $metadata: { httpStatusCode } });
}

/** Mocks GetObject to return `content` and captures what gets uploaded. */
function mockSourceObject(content) {
  s3Mock.on(GetObjectCommand).callsFake(() => ({
    Body: Readable.from([content]),
    ContentLength: content.length,
    ETag: `"${ETAG}"`,
    LastModified: LAST_MODIFIED,
  }));

  const uploaded = { put: undefined, parts: [] };
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    uploaded.put = input;
    return { ETag: '"archive"' };
  });
  s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
  s3Mock.on(UploadPartCommand).callsFake((input) => {
    uploaded.parts[input.PartNumber - 1] = Buffer.from(input.Body);
    return { ETag: `"part-${input.PartNumber}"` };
  });
  s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"archive-mpu"' });

  uploaded.body = () => (uploaded.put ? Buffer.from(uploaded.put.Body) : Buffer.concat(uploaded.parts));
  s3Mock
    .on(HeadObjectCommand, { Key: "archived/2026/09/result.json.zip" })
    .callsFake(() => ({ ContentLength: uploaded.body().length }));
  s3Mock.on(HeadObjectCommand, { Key: "incoming/2026/09/result.json" }).resolves({ ETag: `"${ETAG}"` });
  s3Mock.on(DeleteObjectCommand).resolves({});
  return uploaded;
}

function readZip(buffer) {
  const entries = new AdmZip(buffer).getEntries();
  return entries.map((entry) => ({ name: entry.entryName, data: entry.getData() }));
}

beforeEach(() => {
  s3Mock.reset();
});

describe("parseS3Record", () => {
  it("decodes URL-encoded keys from S3 notifications", () => {
    const { key } = parseS3Record(s3Event("incoming/video+results/r%C3%A9sum%C3%A9%2B1.json").Records[0]);
    assert.equal(key, "incoming/video results/résumé+1.json");
  });

  it("rejects records that are not S3 notifications", () => {
    assert.throws(() => parseS3Record({ eventSource: "aws:sqs" }), /not an S3 notification/);
  });
});

describe("archiveKeyFor", () => {
  it("maps the source prefix onto the archive prefix", () => {
    const config = { sourcePrefix: "incoming/", archivePrefix: "archived/" };
    assert.equal(archiveKeyFor("incoming/a/b.json", config), "archived/a/b.json.zip");
  });
});

describe("handler", () => {
  it("zips the object, uploads it and deletes the original", async () => {
    const content = Buffer.from(JSON.stringify({ videoId: "v-1", frames: Array(500).fill({ score: 0.97 }) }));
    const uploaded = mockSourceObject(content);

    const { results } = await handler(s3Event("incoming/2026/09/result.json"));

    assert.equal(results[0].status, "archived");
    assert.equal(results[0].archiveKey, "archived/2026/09/result.json.zip");
    assert.equal(results[0].sourceDeleted, true);
    assert.ok(results[0].archiveBytes < content.length, "archive should be smaller than the JSON source");

    const [get] = s3Mock.commandCalls(GetObjectCommand);
    assert.equal(get.args[0].input.IfMatch, `"${ETAG}"`);

    assert.equal(uploaded.put.Bucket, BUCKET);
    assert.equal(uploaded.put.ContentType, "application/zip");
    assert.equal(uploaded.put.StorageClass, "STANDARD");
    assert.deepEqual(uploaded.put.Metadata, {
      "source-key": encodeURIComponent("incoming/2026/09/result.json"),
      "source-etag": ETAG,
      "source-size": String(content.length),
    });

    const entries = readZip(uploaded.body());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "result.json");
    assert.deepEqual(entries[0].data, content);

    const [del] = s3Mock.commandCalls(DeleteObjectCommand);
    assert.deepEqual(del.args[0].input, { Bucket: BUCKET, Key: "incoming/2026/09/result.json", VersionId: undefined });
  });

  it("uses multipart upload for archives larger than one part", async () => {
    const content = randomBytes(6 * 1024 * 1024); // incompressible, so the ZIP exceeds 5 MiB
    const uploaded = mockSourceObject(content);

    const { results } = await handler(s3Event("incoming/2026/09/result.json"));

    assert.equal(results[0].status, "archived");
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
    assert.ok(s3Mock.commandCalls(UploadPartCommand).length >= 2);
    assert.deepEqual(readZip(uploaded.body())[0].data, content);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 1);
  });

  for (const [key, reason] of [
    ["archived/2026/09/result.json.zip", "already-archived"],
    ["other/result.json", "outside-source-prefix"],
    ["incoming/2026/", "folder-placeholder"],
  ]) {
    it(`skips ${key} (${reason}) without touching S3`, async () => {
      const { results } = await handler(s3Event(key));
      assert.deepEqual(results, [{ status: "skipped", bucket: BUCKET, key, reason }]);
      assert.equal(s3Mock.calls().length, 0);
    });
  }

  it("treats a missing source as already archived (duplicate delivery)", async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error("NoSuchKey", 404));

    const { results } = await handler(s3Event("incoming/2026/09/result.json"));

    assert.equal(results[0].reason, "source-not-found");
    assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("skips a source that was overwritten after the event was sent", async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error("PreconditionFailed", 412));

    const { results } = await handler(s3Event("incoming/2026/09/result.json"));

    assert.equal(results[0].reason, "source-changed");
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("keeps the source when the key is overwritten while archiving", async () => {
    mockSourceObject(Buffer.from("{}"));
    s3Mock.on(HeadObjectCommand, { Key: "incoming/2026/09/result.json" }).rejects(s3Error("PreconditionFailed", 412));

    const { results } = await handler(s3Event("incoming/2026/09/result.json"));

    assert.equal(results[0].status, "archived");
    assert.equal(results[0].sourceDeleted, false);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("does not delete the source if the stored archive size does not match", async () => {
    mockSourceObject(Buffer.from("{}"));
    s3Mock.on(HeadObjectCommand, { Key: "archived/2026/09/result.json.zip" }).resolves({ ContentLength: 1 });

    await assert.rejects(handler(s3Event("incoming/2026/09/result.json")), AggregateError);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("does not delete the source if the upload fails", async () => {
    mockSourceObject(Buffer.from("{}"));
    s3Mock.on(PutObjectCommand).rejects(s3Error("SlowDown", 503));

    await assert.rejects(handler(s3Event("incoming/2026/09/result.json")), AggregateError);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  });

  it("deletes the exact archived version in versioned buckets", async () => {
    mockSourceObject(Buffer.from("{}"));

    await handler(s3Event("incoming/2026/09/result.json", { versionId: "v42" }));

    assert.equal(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input.VersionId, "v42");
    assert.equal(s3Mock.commandCalls(HeadObjectCommand, { Key: "incoming/2026/09/result.json" }).length, 0);
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.VersionId, "v42");
  });

  it("fails the invocation when any record fails so Lambda can retry", async () => {
    mockSourceObject(Buffer.from("{}"));
    const event = s3Event("incoming/2026/09/result.json");
    event.Records.push(s3Event("incoming/2026/09/missing.json").Records[0]);
    s3Mock.on(GetObjectCommand, { Key: "incoming/2026/09/missing.json" }).rejects(s3Error("AccessDenied", 403));

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
