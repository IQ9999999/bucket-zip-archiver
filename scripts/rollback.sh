#!/usr/bin/env bash
#
# Roll the archiver's "live" alias back to a previously published version.
#
#   scripts/rollback.sh             list versions and show where the alias points
#   scripts/rollback.sh previous    point the alias at the version before the current one
#   scripts/rollback.sh <version>   point the alias at a specific version
#
# The S3 trigger invokes the alias, so the change takes effect immediately.
# CloudFormation still owns the alias: the next `sam deploy` moves it to the
# newest version again, so follow up by reverting the faulty commit and
# redeploying.
#
# Environment: STACK_NAME (default s3-zip-archiver), ALIAS (default live),
# plus the usual AWS_PROFILE / AWS_REGION.
set -euo pipefail

STACK_NAME="${STACK_NAME:-s3-zip-archiver}"
ALIAS="${ALIAS:-live}"

function_name="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ArchiverFunctionName'].OutputValue" \
  --output text)"
current="$(aws lambda get-alias --function-name "$function_name" --name "$ALIAS" \
  --query FunctionVersion --output text)"

if [[ $# -eq 0 ]]; then
  echo "Alias '$ALIAS' of $function_name -> version $current"
  aws lambda list-versions-by-function --function-name "$function_name" \
    --query "Versions[?Version!='\$LATEST'].[Version, LastModified, CodeSha256, Description]" \
    --output table
  echo "Roll back with: $0 previous | $0 <version>"
  exit 0
fi

target="$1"
if [[ "$target" == "previous" ]]; then
  target="$(aws lambda list-versions-by-function --function-name "$function_name" \
    --query "Versions[?Version!='\$LATEST'].Version" --output text \
    | tr '\t' '\n' | sort -n | awk -v cur="$current" '$1 < cur' | tail -n 1)"
  if [[ -z "$target" ]]; then
    echo "No version older than $current to roll back to" >&2
    exit 1
  fi
fi

# Fails with ResourceNotFoundException if the version does not exist.
aws lambda get-function --function-name "$function_name" --qualifier "$target" >/dev/null

aws lambda update-alias --function-name "$function_name" --name "$ALIAS" \
  --function-version "$target" --query '[AliasArn, FunctionVersion]' --output text
echo "Alias '$ALIAS' moved from version $current to $target"
