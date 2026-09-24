#!/usr/bin/env bash
set -euo pipefail
cat >&2 <<'MSG'
VPS source builds have been retired. Use the Windows controller:
  .\ops\Build-HubRelease.ps1
  .\ops\Deploy-DevArtifact.ps1 -ArtifactDirectory <verified artifact directory>
Builds run on etcom-hub; the artifact deploy command supports dev only.
Production deployment requires the owner's explicit permission and a separate release review.
MSG
exit 2
