#!/usr/bin/env bash
# Turn the raw Playwright take into a submission-ready MP4.
#
#   ./assemble.sh                          # webm -> mp4, no audio
#   ./assemble.sh --voice narration.m4a    # mux your recorded narration
#   ./assemble.sh --voice v.m4a --subs captions.srt
#
# Trim dead air first if you need to hit a hard time limit:
#   ./assemble.sh --start 00:00:03 --end 00:03:05
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="output"
VOICE=""; SUBS=""; START=""; END=""; SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --subs)  SUBS="$2";  shift 2 ;;
    --start) START="$2"; shift 2 ;;
    --end)   END="$2";   shift 2 ;;
    --src)   SRC="$2";   shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Playwright writes one .webm per test run into recordings/<hash>/.
if [[ -z "$SRC" ]]; then
  SRC=$(find recordings -name '*.webm' -type f -print0 2>/dev/null \
        | xargs -0 ls -t 2>/dev/null | head -1 || true)
fi
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "No recording found under recordings/. Run the Playwright take first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
FINAL="$OUT_DIR/potatoguard-demo-$STAMP.mp4"

echo "source : $SRC"
DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")
printf 'length : %.0fs\n' "$DURATION"

args=(-hide_banner -loglevel error -y)
[[ -n "$START" ]] && args+=(-ss "$START")
[[ -n "$END"   ]] && args+=(-to "$END")
args+=(-i "$SRC")
[[ -n "$VOICE" ]] && args+=(-i "$VOICE")

filter="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black,format=yuv420p"
[[ -n "$SUBS" ]] && filter="$filter,subtitles=$SUBS:force_style='FontName=Helvetica,FontSize=22,OutlineColour=&H80000000,BorderStyle=3'"

args+=(-vf "$filter" -c:v libx264 -preset slow -crf 20 -r 30 -movflags +faststart)

if [[ -n "$VOICE" ]]; then
  # Video length wins; narration is trimmed or padded to match the picture.
  args+=(-map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -shortest)
else
  args+=(-an)
fi

args+=("$FINAL")
ffmpeg "${args[@]}"

echo "output : $FINAL"
printf 'size   : %s\n' "$(du -h "$FINAL" | cut -f1)"
