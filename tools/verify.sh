#!/usr/bin/env bash
# One-shot acceptance gate: the node suites first, then a real browser against a real
# server, driven over CDP. Everything this starts exits with the script, including the
# Chrome it started in a throwaway profile.
#
#   bash tools/verify.sh                          # node suites + @boot @play @routes @save @reloaded @pointer
#   SCENARIOS="pointer" bash tools/verify.sh      # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh              # browser only (what the CI browser job does)
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process will not
# exit on its own. This game is 2D canvas, so plain headless Chrome is enough.
#
# PORTS. The siblings hold :5180/:9340 (gridlock), :5181/:9341 (nine-rings) and :5185-:5192 /
# :9344-:9352 for the rest of the batch, so this repo takes :5193/:9353 and must not be
# pointed at either of those. Only ONE headless Chrome can own a debug port on this machine
# at a time, and an orphan Chrome left behind by a killed agent will happily answer
# /json/version on a squatted port: that is how a run gets reported as "0 browser asserts"
# while looking green. So the first thing this script does is refuse to start in that state.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9353}
WEB_PORT=${WEB_PORT:-5193}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
SHOT_DIR=${SHOT_DIR:-/tmp/puzzle-brief/shots}
TAG=nim
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

if curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
  echo "something already owns the devtools port :$CDP_PORT" >&2
  pgrep -fl remote-debugging-port >&2 || true
  echo "refusing to share a Chrome: kill the orphan or run with CDP_PORT=<other>" >&2
  exit 9
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >/tmp/$TAG-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/$TAG-server.log 2>&1 &
SPID=$!
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# ran inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished. It is in the cleanup list for the same reason — a
# `sleep 300` still running keeps bash's job table occupied and prints `Killed: 9` at the end.
( sleep ${WD_TIMEOUT:-300}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!
cleanup() {
  kill $WD 2>/dev/null
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  wait $WD 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, and the page is
# a module graph over HTTP: wait on both endpoints, never on a guessed sleep.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0
TOTAL_ROWS=0
TOTAL_ASSERTS=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    OUT=$(node "$f") || FAILED=1
    printf '%s\n' "$OUT" | grep -E 'FAIL|^rows:'
    R=$(printf '%s' "$OUT" | sed -nE 's/.*rows: ([0-9]+).*/\1/p' | tail -1)
    A=$(printf '%s' "$OUT" | sed -nE 's/.*asserts: ([0-9]+).*/\1/p' | tail -1)
    TOTAL_ROWS=$((TOTAL_ROWS + ${R:-0}))
    TOTAL_ASSERTS=$((TOTAL_ASSERTS + ${A:-0}))
  done
  echo "node total: rows $TOTAL_ROWS asserts $TOTAL_ASSERTS"
fi

export CDP_PORT
export BASE_URL=$BASE
mkdir -p "$SHOT_DIR"
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js is 54 measured rows and the shell resolves a route before it reports a
# state, so wait on window.nim rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.nim?window.nim.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.nim never appeared at $BASE" >&2; exit 5; }
CSIZE=$(node tools/playtest.mjs eval "(() => { const c = document.getElementById('board'); return c.width + 'x' + c.height; })()" nonav | tr -d '\n" ')
echo "canvas backing store: $CSIZE"

BROWS_ROWS=0
# @reloaded has to run after @save (it reads what @save left on disk), and each scenario is
# its own driver process, which is what makes the "eval without nonav" reload real.
for s in ${SCENARIOS:-boot play routes save reloaded pointer}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  SUM=$(printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
rows = d.get("rows", [])
bad = [r for r in rows if not r.get("pass")]
print("rows: %d fail: %d" % (len(rows), len(bad)))
for r in bad:
    print("  FAIL", r["test"], json.dumps(r.get("detail"), ensure_ascii=False)[:300])
sys.exit(1 if bad else 0)
' ) || FAILED=1
  printf '%s\n' "$SUM"
  BR=$(printf '%s' "$SUM" | sed -nE 's/rows: ([0-9]+).*/\1/p' | head -1)
  BROWS_ROWS=$((BROWS_ROWS + ${BR:-0}))
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "$SHOT_DIR/$TAG-$s.png" >/dev/null 2>&1
done
echo "browser total: rows $BROWS_ROWS (each row is one assertion; several sweep the whole 54-row pool, and the mismatch count they checked is printed in their detail)"

echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
