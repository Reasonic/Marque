#!/usr/bin/env bash
# Fetch benchmark fixtures.
#
# These are public documents, but they are other people's copyrighted work, so
# they are downloaded rather than redistributed in this repository.
#
#   ./bench/fetch-fixtures.sh
set -euo pipefail

cd "$(dirname "$0")/fixtures"

fetch() {
  local name="$1" url="$2"
  if [ -s "$name" ]; then
    echo "  have  $name"
    return
  fi
  echo "  get   $name"
  if ! curl -fsSL --retry 3 -o "$name" "$url"; then
    echo "  FAIL  $name — $url" >&2
    rm -f "$name"
    return 1
  fi
  # A redirect to an HTML error page still exits 0, so check the magic bytes.
  if [ "$(head -c 4 "$name")" != "%PDF" ]; then
    echo "  FAIL  $name — not a PDF (got $(file -b "$name" | cut -c1-40))" >&2
    rm -f "$name"
    return 1
  fi
}

echo "Fetching fixtures into $(pwd)"

failed=0
fetch attn.pdf "https://arxiv.org/pdf/1706.03762" || failed=1   # Attention Is All You Need
fetch bert.pdf "https://arxiv.org/pdf/1810.04805" || failed=1   # BERT — no embedded outline
fetch gpt4.pdf "https://arxiv.org/pdf/2303.08774" || failed=1   # GPT-4 Technical Report
fetch boe.pdf  "https://www.bankofengland.co.uk/-/media/boe/files/annual-report/2023/boe-2023.pdf" || failed=1
fetch brk.pdf  "https://www.berkshirehathaway.com/2023ar/2023ar.pdf" || failed=1

if [ "$failed" -ne 0 ]; then
  echo
  echo "Some fixtures failed. Annual-report URLs move; check the publisher's site." >&2
  exit 1
fi

echo "Done."
