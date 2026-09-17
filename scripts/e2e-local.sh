#!/usr/bin/env bash
set -euo pipefail

# Requirements: Docker, AWS CLI v2, curl, jq, Python 3. No real AWS is used.
# Override MOTO_PORT / LAMBDA_PORT when running concurrent tests.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_ID="s3-zip-archiver-e2e-$(date +%s)-$$-${RANDOM}"
NETWORK="$RUN_ID-network"
MOTO="$RUN_ID-moto"
LAMBDA="$RUN_ID-lambda"
IMAGE="$RUN_ID:local"
BUCKET="$RUN_ID"
MOTO_HOST=moto.local
MOTO_PORT=${MOTO_PORT:-18543}
LAMBDA_PORT=${LAMBDA_PORT:-18943}
WORK=''
NETWORK_CREATED=0
MOTO_CREATED=0
LAMBDA_CREATED=0
IMAGE_BUILT=0
log() { printf '[e2e] %s\n' "$*"; }
fail() { printf '[e2e] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
  rc=$?
  trap - EXIT
  set +e
  if [ "$rc" -ne 0 ]; then
    for container in "$MOTO" "$LAMBDA"; do
      log "Logs: $container"
      docker logs "$container" 2>&1
    done
  fi
  cleanup_failed=0
  if [ "$LAMBDA_CREATED" -eq 1 ]; then docker rm -f "$LAMBDA" >/dev/null || cleanup_failed=1; fi
  if [ "$MOTO_CREATED" -eq 1 ]; then docker rm -f "$MOTO" >/dev/null || cleanup_failed=1; fi
  if [ "$NETWORK_CREATED" -eq 1 ]; then docker network rm "$NETWORK" >/dev/null || cleanup_failed=1; fi
  if [ "$IMAGE_BUILT" -eq 1 ]; then docker image rm "$IMAGE" >/dev/null || cleanup_failed=1; fi
  if [ -n "$WORK" ]; then rm -rf -- "$WORK" || cleanup_failed=1; fi
  if [ "$cleanup_failed" -ne 0 ]; then rc=1; fi
  if [ "$rc" -eq 0 ]; then
    printf 'PASS: s3-zip-archiver-e2e\n'
  else
    printf 'FAIL: s3-zip-archiver-e2e (exit %s)\n' "$rc" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for tool in docker aws curl jq python3; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
for port in "$MOTO_PORT" "$LAMBDA_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || fail "Invalid port: $port"
done
[ "$MOTO_PORT" != "$LAMBDA_PORT" ] || fail 'Host ports must differ'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/s3-zip-archiver-e2e.XXXXXXXX")
# Isolate CLI credentials/config and force every CLI request to localhost.
export AWS_ACCESS_KEY_ID=testing AWS_SECRET_ACCESS_KEY=testing
export AWS_REGION=ap-southeast-1 AWS_DEFAULT_REGION=ap-southeast-1
export AWS_EC2_METADATA_DISABLED=true AWS_PAGER='' AWS_MAX_ATTEMPTS=1
export AWS_CONFIG_FILE="$WORK/aws-config" AWS_SHARED_CREDENTIALS_FILE="$WORK/aws-credentials"
unset AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE
printf '[default]\ns3 =\n    addressing_style = path\n' > "$AWS_CONFIG_FILE"
: > "$AWS_SHARED_CREDENTIALS_FILE"
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
s3() {
  aws --endpoint-url "http://127.0.0.1:$MOTO_PORT" --region ap-southeast-1 \
    --cli-connect-timeout 3 --cli-read-timeout 30 s3api "$@"
}
invoke() {
  curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 120 \
    -H 'Content-Type: application/json' --data-binary "@$1" \
    "http://127.0.0.1:$LAMBDA_PORT/2015-03-31/functions/function/invocations" > "$2"
  jq -e 'has("results") and (has("errorMessage") | not)' "$2" >/dev/null || {
    cat "$2" >&2; fail 'Lambda returned an error';
  }
}
log 'Checking Docker and building the real Lambda image'
docker info >/dev/null
docker build --tag "$IMAGE" "$ROOT/src/archiver"
IMAGE_BUILT=1
docker network create "$NETWORK" >/dev/null
NETWORK_CREATED=1
docker create --name "$MOTO" --network "$NETWORK" \
  --network-alias "$MOTO_HOST" --network-alias "$BUCKET.$MOTO_HOST" \
  -p "127.0.0.1:$MOTO_PORT:5000" motoserver/moto:latest >/dev/null
MOTO_CREATED=1
docker start "$MOTO" >/dev/null
log 'Waiting for moto S3 (up to 60 attempts)'
ready=0
for ((attempt=1; attempt<=60; attempt++)); do
  if s3 list-buckets > "$WORK/moto-ready.json" 2> "$WORK/moto-ready.err"; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { cat "$WORK/moto-ready.err" >&2; fail 'moto did not become ready'; }
docker create --name "$LAMBDA" --network "$NETWORK" -p "127.0.0.1:$LAMBDA_PORT:8080" \
  -e AWS_ACCESS_KEY_ID=testing -e AWS_SECRET_ACCESS_KEY=testing \
  -e AWS_REGION=ap-southeast-1 -e AWS_DEFAULT_REGION=ap-southeast-1 \
  -e AWS_EC2_METADATA_DISABLED=true -e "AWS_ENDPOINT_URL_S3=http://$MOTO_HOST:5000" \
  -e SOURCE_PREFIX=incoming/ -e ARCHIVE_PREFIX=archived/ "$IMAGE" >/dev/null
LAMBDA_CREATED=1
docker start "$LAMBDA" >/dev/null
log 'Waiting for Lambda RIE (up to 60 attempts)'
ready=0
for ((attempt=1; attempt<=60; attempt++)); do
  if curl --noproxy '*' --silent --output /dev/null --connect-timeout 1 --max-time 2 \
    "http://127.0.0.1:$LAMBDA_PORT/"; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail 'Lambda RIE did not become ready'
s3 create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=ap-southeast-1 >/dev/null
log 'Generating JSON, Unicode/space-key, and 7 MiB random fixtures'
python3 - "$WORK" <<'PY'
import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / '0.bin').write_text(json.dumps({'records': [{'id': i, 'text': 'example payload ' * 10} for i in range(20000)]}), encoding='utf-8')
(root / '1.bin').write_bytes('Nested path, spaces, literal +, and café 雪.\n'.encode('utf-8'))
(root / '2.bin').write_bytes(os.urandom(7 * 1024 * 1024))
(root / 'keys.json').write_text(json.dumps(['incoming/data.json', 'incoming/nested folder/café 雪 + report.txt', 'incoming/random.bin']), encoding='utf-8')
PY
for i in 0 1 2; do
  key=$(jq -r ".[$i]" "$WORK/keys.json")
  s3 put-object --bucket "$BUCKET" --key "$key" --body "$WORK/$i.bin" > "$WORK/put-$i.json"
done
python3 - "$WORK" "$BUCKET" "$ROOT/events/s3-object-created.json" <<'PY'
import copy, datetime, json, pathlib, sys, urllib.parse
root, bucket, sample = pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3])
records = []
for i, key in enumerate(json.loads((root / 'keys.json').read_text())):
    record = copy.deepcopy(json.loads(sample.read_text())['Records'][0])
    record['eventTime'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
    record['s3']['bucket'].update(name=bucket, arn=f'arn:aws:s3:::{bucket}')
    record['s3']['object'].update(key=urllib.parse.quote_plus(key, safe='/'), size=(root / f'{i}.bin').stat().st_size,
                                eTag=json.loads((root / f'put-{i}.json').read_text())['ETag'].strip('"'), sequencer=f'{i+1:016X}')
    records.append(record)
(root / 'event.json').write_text(json.dumps({'Records': records}))
PY
log 'Invoking the real handler for all three records'
invoke "$WORK/event.json" "$WORK/result.json"
cat "$WORK/result.json"
printf '\n'
for i in 0 1 2; do
  key=$(jq -r ".[$i]" "$WORK/keys.json")
  archive="archived/${key#incoming/}.zip"
  jq -e --arg key "$key" --arg archive "$archive" \
    '.results | length == 3 and (map(select(.key == $key and .archiveKey == $archive and .status == "archived" and .sourceDeleted == true)) | length == 1)' \
    "$WORK/result.json" >/dev/null
  s3 head-object --bucket "$BUCKET" --key "$archive" > "$WORK/head-$i.json"
  s3 get-object --bucket "$BUCKET" --key "$archive" "$WORK/$i.zip" >/dev/null
  if s3 head-object --bucket "$BUCKET" --key "$key" > /dev/null 2> "$WORK/missing.err"; then
    fail "Source still exists: $key"
  fi
  # A permission/connection failure must not masquerade as source deletion.
  grep -Eq '\(404\)|\(NoSuchKey\)|\(NotFound\)' "$WORK/missing.err" || { cat "$WORK/missing.err" >&2; fail 'Expected source 404'; }
done
python3 - "$WORK" <<'PY'
import hashlib, json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
results = json.loads((root / 'result.json').read_text())['results']
for i, key in enumerate(json.loads((root / 'keys.json').read_text())):
    raw, archive = root / f'{i}.bin', root / f'{i}.zip'
    with zipfile.ZipFile(archive) as z:
        assert z.namelist() == [key.rsplit('/', 1)[1]], z.namelist()
        assert hashlib.sha256(z.read(z.namelist()[0])).digest() == hashlib.sha256(raw.read_bytes()).digest()
    head = json.loads((root / f'head-{i}.json').read_text())
    result = next(r for r in results if r['key'] == key)
    assert result['sourceBytes'] == raw.stat().st_size
    assert result['archiveBytes'] == head['ContentLength'] == archive.stat().st_size
    if i == 2:
        assert archive.stat().st_size > 6 * 1024 * 1024
        assert int(head['ETag'].strip('"').rsplit('-', 1)[1]) >= 2, head['ETag']
    print(f'[e2e] Verified single ZIP entry, SHA-256, sizes, deletion: {key}')
print('[e2e] Verified multipart archive ETag for random fixture')
PY
log 'Replaying the same event: all records must be source-not-found'
invoke "$WORK/event.json" "$WORK/replay.json"
jq -e '.results | length == 3 and all(.[]; .status == "skipped" and .reason == "source-not-found")' "$WORK/replay.json" >/dev/null
log 'Sending an archived-key event: must be already-archived'
jq --slurpfile head "$WORK/head-0.json" \
  '{Records: [.Records[0] | .s3.object.key = "archived/data.json.zip" | .s3.object.size = $head[0].ContentLength | .s3.object.eTag = ($head[0].ETag | gsub("\""; ""))]}' \
  "$WORK/event.json" > "$WORK/archived-event.json"
invoke "$WORK/archived-event.json" "$WORK/archived-result.json"
jq -e '.results | length == 1 and all(.[]; .status == "skipped" and .reason == "already-archived")' "$WORK/archived-result.json" >/dev/null
for i in 0 1 2; do
  key=$(jq -r ".[$i]" "$WORK/keys.json")
  archive="archived/${key#incoming/}.zip"
  s3 get-object --bucket "$BUCKET" --key "$archive" "$WORK/$i-replayed.zip" >/dev/null
  cmp "$WORK/$i.zip" "$WORK/$i-replayed.zip"
  s3 head-object --bucket "$BUCKET" --key "$archive" > "$WORK/replayed-head-$i.json"
  jq -e --slurpfile before "$WORK/head-$i.json" \
    '.ETag == $before[0].ETag and .ContentLength == $before[0].ContentLength and .LastModified == $before[0].LastModified' \
    "$WORK/replayed-head-$i.json" >/dev/null
done
log 'All archives remain byte-identical with unchanged ETags, sizes, and modification times'
