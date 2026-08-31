#!/bin/bash

#
# PotatoGuard Pre-Submission Check
#
# This script performs a final validation before submitting to hackathon judges.
# It is a helper tool and does NOT guarantee that no secrets have ever existed
# in Git history or build artifacts.
#

set -e

echo "🔍 PotatoGuard Pre-Submission Check"
echo "===================================="
echo

# 1. Run npm check
echo "1. Running npm run check..."
npm run check > /tmp/check.log 2>&1 || {
  echo "❌ FAILED: npm run check"
  tail -50 /tmp/check.log
  exit 1
}
echo "✓ typecheck, test, and build passed"
echo

# 2. Check .env and .env.production are not tracked
echo "2. Checking .env files are not tracked..."
if git ls-files | grep -E "^\.env($|\.)" > /dev/null; then
  echo "❌ FAILED: .env files are tracked in Git"
  git ls-files | grep -E "^\.env($|\.)"
  exit 1
fi
echo "✓ .env and .env.production are not tracked"
echo

# 3. Check obvious sensitive filenames
echo "3. Checking for suspicious sensitive filenames..."
SUSPICIOUS=$(git ls-files | grep -i -E "(secret|password|key|credential|token|ark)" || true)
if [ -n "$SUSPICIOUS" ]; then
  echo "⚠️  WARNING: Found files with suspicious names:"
  echo "$SUSPICIOUS"
  echo "Please verify these do not contain secrets."
fi
echo

# 4. Quick check for obvious hardcoded patterns
echo "4. Scanning tracked files for common secret patterns..."
PATTERNS=(
  "ARK_API_KEY="
  "api_key="
  "api-key="
  "apiKey="
  "password="
  "sk-"
  "Bearer "
  "Authorization: "
)

FOUND_SECRETS=0
for pattern in "${PATTERNS[@]}"; do
  # Only check source and config files, skip node_modules
  if git grep -l "$pattern" -- ':!node_modules' ':!.git' ':!dist' ':!build' 2>/dev/null > /tmp/files.txt; then
    while IFS= read -r file; do
      # Whitelist known safe files
      if [[ "$file" == ".env.example" ]] || [[ "$file" == "docs/"* ]] || [[ "$file" == "README.md" ]]; then
        continue
      fi
      echo "⚠️  Found pattern '$pattern' in $file"
      echo "Please verify this is not a real secret."
      FOUND_SECRETS=$((FOUND_SECRETS + 1))
    done < /tmp/files.txt
  fi
done

if [ $FOUND_SECRETS -gt 0 ]; then
  echo "❌ FAILED: Found $FOUND_SECRETS potential secrets in tracked files"
  exit 1
fi
echo "✓ No obvious hardcoded secrets detected"
echo

# 5. Show uncommitted changes
echo "5. Checking for uncommitted changes..."
git status --short
echo

# 6. Show branch and commit info
echo "6. Git information:"
echo "   Branch: $(git rev-parse --abbrev-ref HEAD)"
echo "   Latest: $(git log -1 --oneline)"
echo

echo "===================================="
echo "✓ Pre-submission check complete"
echo
echo "📝 Manual verification checklist:"
echo "  ☐ Verify .env.example contains only placeholders"
echo "  ☐ Confirm no real Ark API key in .env or any config"
echo "  ☐ Confirm no protected document contents in docs"
echo "  ☐ Confirm no real user credentials in fixtures"
echo "  ☐ Review Git log for accidental commits of .env"
echo "  ☐ Verify all security-relevant tests pass"
echo "  ☐ Test npm run poc locally and confirm startup output"
echo "  ☐ Test 3-minute demo scenarios with fresh browser session"
echo

echo "💡 Remember: This script is a helper tool, not a security guarantee."
echo "   A comprehensive Git history review is still recommended."
