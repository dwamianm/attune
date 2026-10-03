#!/usr/bin/env bash
# Publishes the Attune docs to AWS at https://attuneui.dev (README, "Deploy").
#
#   1. The certificate stack (cert.yaml) in us-east-1, where CloudFront reads it.
#   2. The site stack (template.yaml) in us-west-1: S3, CloudFront, DNS.
#   3. The static site (out/, from pnpm build) to the bucket.
#
# Safe to run again: each step only changes what changed. No secrets: the
# site is public.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=junction
REGION=us-west-1
DOMAIN=attuneui.dev
STACK=attune-docs
CERT_STACK=attune-docs-cert

awsp() { aws --profile "$PROFILE" "$@"; }
output() { awsp cloudformation describe-stacks --region "$1" --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }

# --- Build -----------------------------------------------------------------

echo "[deploy] building the docs (static export and search index)"
pnpm build

# --- Certificate (us-east-1) -------------------------------------------------

ZONE_ID=$(awsp route53 list-hosted-zones-by-name --dns-name "$DOMAIN" \
  --query "HostedZones[?Name=='$DOMAIN.' && Config.PrivateZone==\`false\`].Id | [0]" --output text)
ZONE_ID=${ZONE_ID#/hostedzone/}
[[ $ZONE_ID != None && -n $ZONE_ID ]] || { echo "[deploy] no public Route 53 zone for $DOMAIN" >&2; exit 1; }

echo "[deploy] certificate stack $CERT_STACK (us-east-1); the first run waits for DNS validation"
awsp cloudformation deploy --region us-east-1 --stack-name "$CERT_STACK" \
  --template-file deploy/cert.yaml --no-fail-on-empty-changeset \
  --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$ZONE_ID"
CERT_ARN=$(output us-east-1 "$CERT_STACK" CertificateArn)

# --- Site stack (us-west-1) ----------------------------------------------------

echo "[deploy] site stack $STACK ($REGION); the first run waits for CloudFront (about 5 to 10 min)"
awsp cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file deploy/template.yaml --no-fail-on-empty-changeset \
  --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$ZONE_ID" CertificateArn="$CERT_ARN"

BUCKET=$(output "$REGION" "$STACK" BucketName)
DIST_ID=$(output "$REGION" "$STACK" DistributionId)

# --- Files -------------------------------------------------------------------

echo "[deploy] site to s3://$BUCKET"
# Hashed assets first and kept, so a page that is still open finds its files.
awsp s3 sync out/_next/static "s3://$BUCKET/_next/static" --only-show-errors \
  --cache-control "public, max-age=31536000, immutable"
awsp s3 sync out "s3://$BUCKET" --only-show-errors --delete --exclude "_next/static/*" \
  --cache-control "no-cache"
# The files for AI assistants, as UTF-8 text.
for f in llms.txt llms-full.txt; do
  awsp s3 cp "out/$f" "s3://$BUCKET/$f" --only-show-errors \
    --content-type "text/plain; charset=utf-8" --cache-control "no-cache"
done
awsp cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --query Invalidation.Id --output text > /dev/null

echo "[deploy] done: https://$DOMAIN"
