#!/usr/bin/env bash
# Publishes Attune to AWS at https://attuneui.com (README, "Deploy to AWS").
#
#   1. The certificate stack (cert.yaml) in us-east-1, where CloudFront reads it.
#   2. The main stack (template.yaml) in us-west-1: S3, CloudFront, Lambda, DNS.
#   3. The Lambda code (server/lambda.ts, bundled) and the web app (dist/).
#
# Safe to run again: each step only changes what changed. The site password
# and the CloudFront secret are made on the first run and kept in .env.deploy
# (git-ignored), so later runs reuse them. The Jev key comes from .env.
set -euo pipefail
cd "$(dirname "$0")/.."

PROFILE=junction
REGION=us-west-1
DOMAIN=attuneui.com
STACK=attune
CERT_STACK=attune-cert
SECRETS=.env.deploy
BUILD=.deploy

awsp() { aws --profile "$PROFILE" "$@"; }
output() { awsp cloudformation describe-stacks --region "$1" --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }

# --- Secrets ---------------------------------------------------------------

if [[ ! -f $SECRETS ]]; then
  umask 077
  {
    echo "# Made by deploy/deploy.sh. The site login, and the secret CloudFront sends the API."
    echo "SITE_USER=attune"
    echo "SITE_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)"
    echo "ORIGIN_SECRET=$(openssl rand -hex 32)"
  } > "$SECRETS"
  echo "[deploy] made $SECRETS with a new site password"
fi

read_env() { node -e 'process.loadEnvFile(process.argv[1]); for (const k of process.argv.slice(2)) if (process.env[k]) { process.stdout.write(process.env[k]); break; }' "$@"; }
SITE_USER=$(read_env "$SECRETS" SITE_USER)
SITE_PASSWORD=$(read_env "$SECRETS" SITE_PASSWORD)
ORIGIN_SECRET=$(read_env "$SECRETS" ORIGIN_SECRET)
JEV_API_KEY=$(read_env .env JEV_API_KEY TYPESAFE_API_KEY)
JEV_MODEL=$(read_env .env JEV_MODEL || true)
[[ -n $JEV_API_KEY ]] || { echo "[deploy] no JEV_API_KEY in .env" >&2; exit 1; }
BASIC_AUTH=$(printf '%s:%s' "$SITE_USER" "$SITE_PASSWORD" | base64)

# --- Build -----------------------------------------------------------------

echo "[deploy] building the web app and the Lambda bundle"
pnpm build
rm -rf "$BUILD" && mkdir -p "$BUILD/lambda"
pnpm exec esbuild server/lambda.ts --bundle --platform=node --format=esm --target=node24 \
  --outfile="$BUILD/lambda/index.mjs" --log-level=warning \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
(cd "$BUILD/lambda" && zip -q ../lambda.zip index.mjs)

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

# --- Main stack (us-west-1) ----------------------------------------------------

echo "[deploy] main stack $STACK ($REGION); the first run waits for CloudFront (about 5 to 10 min)"
awsp cloudformation deploy --region "$REGION" --stack-name "$STACK" \
  --template-file deploy/template.yaml --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides DomainName="$DOMAIN" HostedZoneId="$ZONE_ID" CertificateArn="$CERT_ARN" \
    BasicAuthToken="$BASIC_AUTH" OriginSecret="$ORIGIN_SECRET" JevApiKey="$JEV_API_KEY" JevModel="${JEV_MODEL:-jev-latest}"

BUCKET=$(output "$REGION" "$STACK" BucketName)
DIST_ID=$(output "$REGION" "$STACK" DistributionId)
FUNCTION=$(output "$REGION" "$STACK" FunctionName)

# --- Code and files ----------------------------------------------------------

echo "[deploy] Lambda code"
awsp lambda update-function-code --region "$REGION" --function-name "$FUNCTION" \
  --zip-file "fileb://$BUILD/lambda.zip" --query LastUpdateStatus --output text > /dev/null
awsp lambda wait function-updated-v2 --region "$REGION" --function-name "$FUNCTION"

echo "[deploy] web app to s3://$BUCKET"
# Hashed assets first and kept, so a page that is still open finds its files.
awsp s3 sync dist/assets "s3://$BUCKET/assets" --only-show-errors \
  --cache-control "public, max-age=31536000, immutable"
awsp s3 sync dist "s3://$BUCKET" --only-show-errors --delete --exclude "assets/*" \
  --cache-control "no-cache"
awsp cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" \
  --query Invalidation.Id --output text > /dev/null

echo "[deploy] done: https://$DOMAIN (user $SITE_USER, password in $SECRETS)"
