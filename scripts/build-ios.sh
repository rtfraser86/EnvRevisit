#!/usr/bin/env bash
# One-shot: install deps and start an EAS development build for iPhone.
# Needs EXPO_TOKEN (set it as a GitHub Codespaces secret).
set -e
cd "$(dirname "$0")/.."
if [ -z "$EXPO_TOKEN" ]; then
  echo "EXPO_TOKEN is not set. Add it as a Codespaces secret (github.com/settings/codespaces), then reload the codespace."
  exit 1
fi
npm ci
npx --yes eas-cli@latest whoami
npx --yes eas-cli@latest build --profile development --platform ios
