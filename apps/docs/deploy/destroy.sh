#!/usr/bin/env bash
# Takes the Attune docs off AWS: empties the site bucket, then deletes the
# site stack (us-west-1) and the certificate stack (us-east-1). The Route 53
# zone and the domain stay. Asks before it deletes anything.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=junction
REGION=us-west-1
STACK=attune-docs
CERT_STACK=attune-docs-cert

awsp() { aws --profile "$PROFILE" "$@"; }

read -r -p "Delete the $STACK and $CERT_STACK stacks and every file in the docs bucket? Type yes: " answer
[[ $answer == yes ]] || { echo "Nothing deleted."; exit 1; }

BUCKET=$(awsp cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text 2>/dev/null || true)
if [[ -n $BUCKET && $BUCKET != None ]]; then
  awsp s3 rm "s3://$BUCKET" --recursive --only-show-errors
fi

awsp cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
echo "[destroy] waiting for $STACK (CloudFront takes a few minutes)"
awsp cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"

awsp cloudformation delete-stack --region us-east-1 --stack-name "$CERT_STACK"
awsp cloudformation wait stack-delete-complete --region us-east-1 --stack-name "$CERT_STACK"
echo "[destroy] done"
