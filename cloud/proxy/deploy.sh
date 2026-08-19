#!/usr/bin/env bash
# Deploy the rewind-proxy Cloud Run service.
#
#     cd cloud/proxy && ./deploy.sh
#
# This script exists because the service's configuration used to live
# ONLY as deploy-time state in GCP. Nothing in the repo recorded it, so
# nobody could see that the request timeout was sitting at Cloud Run's
# 300s default -- until a 95-minute meeting hit it and came back as
# "Proxy returned HTTP 504: upstream request timeout". A redeploy from
# an earlier version of this repo would have silently reset it again.
#
# Keep every non-default setting here, not in your shell history.

set -euo pipefail

SERVICE="${SERVICE:-rewind-proxy}"
REGION="${REGION:-us-west2}"

# Request timeout. 3600s is Cloud Run's maximum.
#
# Transcription splits long audio into ~10-minute chunks and runs them
# concurrently (app/audio_chunk.py), so a meeting at the 3-hour
# MAX_RECORDING_DURATION should finish in minutes, not hours. This
# ceiling is the backstop for when that goes wrong, not the mechanism
# we rely on.
TIMEOUT="${TIMEOUT:-3600}"

# Transcribing several chunks at once holds more audio in memory at
# peak than the old one-file-at-a-time path did.
MEMORY="${MEMORY:-2Gi}"
CPU="${CPU:-2}"

echo "Deploying ${SERVICE} to ${REGION} (timeout=${TIMEOUT}s, mem=${MEMORY})"

# Env vars (GEMINI_API_KEY, Supabase credentials) are intentionally NOT
# set here -- they are secrets and Cloud Run preserves them across
# revisions. Set them once with:
#   gcloud run services update rewind-proxy --region REGION \
#     --set-env-vars KEY=value
gcloud run deploy "${SERVICE}" \
    --source . \
    --region "${REGION}" \
    --timeout "${TIMEOUT}" \
    --memory "${MEMORY}" \
    --cpu "${CPU}" \
    --quiet

echo
echo "Deployed. Current config:"
gcloud run services describe "${SERVICE}" --region "${REGION}" \
    --format="table(
        spec.template.spec.timeoutSeconds,
        spec.template.spec.containers[0].resources.limits.memory,
        status.url
    )"
