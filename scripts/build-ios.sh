#!/usr/bin/env bash
# One-shot: install deps and start an EAS build for iPhone.
#   bash scripts/build-ios.sh            development build (needs the dev server running)
#   bash scripts/build-ios.sh preview    standalone build for field use (no dev server needed)
# Needs EXPO_TOKEN (set it as a GitHub Codespaces secret).
set -e
cd "$(dirname "$0")/.."
if [ -z "$EXPO_TOKEN" ]; then
  echo "EXPO_TOKEN is not set. Add it as a Codespaces secret (github.com/settings/codespaces), then reload the codespace."
  exit 1
fi
npm ci
npx --yes eas-cli@latest whoami
npx --yes eas-cli@latest build --profile "${1:-development}" --platform ios
