#!/bin/sh
# The gate. There is no CI (GitHub Actions minutes cost money on a private repository), so this is what holds the
# engine to its checks: run it before you push. It is tools/test/run.mjs and nothing else, so a check that lives
# anywhere but in that file is a rule nobody runs.
#
#   sh check.sh                    the import and three checks, the kernel's suites, the engine's, the reconstruction's
#   sh check.sh --require-assets   with the R2 art cache restored (npm run assets:fetch): a missing file fails
#   sh check.sh kernel             only the suites whose name contains "kernel"
set -e
cd "$(dirname "$0")"
exec node tools/test/run.mjs "$@"
