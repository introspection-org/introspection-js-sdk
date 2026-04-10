#!/usr/bin/env bash
set -uo pipefail

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

failed=0
count=0

for example in $(find . -name "*.ts" -not -path "*/node_modules/*" | sort); do
  echo "--- $example ---"
  count=$((count + 1))
  if ! node --import tsx "$example"; then
    echo "FAILED: $example"
    failed=$((failed + 1))
  fi
done

echo ""
echo "========================================"
echo "Ran $count examples, $failed failed"
exit $((failed > 0))
