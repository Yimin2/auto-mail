#!/bin/bash
# auto-mail macOS 설치: 프로그램 경로 확인 -> config.json 에 기록 -> launchd 에 1분 주기 등록 -> 알림 시험
#   설치:   ./install-mac.sh
#   제거:   ./install-mac.sh --uninstall
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.automail.run"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  say "제거했어요. (메일 데이터는 $DIR 에 그대로 있어요)"
  exit 0
fi

say "1/5 필요한 프로그램 확인"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || fail "Node.js 가 없어요. https://nodejs.org 에서 설치하거나 'brew install node' 를 실행하세요."
EGO="$(command -v ego-browser || true)"
for c in "$HOME/.local/bin/ego-browser" /usr/local/bin/ego-browser /opt/homebrew/bin/ego-browser; do [[ -z "$EGO" && -x "$c" ]] && EGO="$c"; done
[[ -n "$EGO" ]] || fail "ego-browser 가 없어요. ego lite(Mac 버전)를 설치한 뒤 다시 실행하세요."
CLAUDE="$(command -v claude || true)"
for c in "$HOME/.local/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do [[ -z "$CLAUDE" && -x "$c" ]] && CLAUDE="$c"; done
[[ -n "$CLAUDE" ]] || fail "Claude CLI 가 없어요. 'npm install -g @anthropic-ai/claude-code' 로 설치하고 'claude' 를 한 번 실행해 로그인하세요."
echo "  node:        $NODE"
echo "  ego-browser: $EGO"
echo "  claude:      $CLAUDE"

say "2/5 설정 파일(config.json)"
if [[ ! -f "$DIR/config.json" ]]; then
  cp "$DIR/config.example.json" "$DIR/config.json"
  fail "config.json 을 만들었어요. 내 그룹웨어 값으로 채운 뒤 다시 실행하세요: $DIR/config.json"
fi
"$NODE" -e '
  const fs = require("fs"), f = process.argv[1];
  const c = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  c.egoPath = process.argv[2]; c.claudePath = process.argv[3];
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$DIR/config.json" "$EGO" "$CLAUDE"
echo "  egoPath · claudePath 를 기록했어요"

say "3/5 알림 도구"
if command -v terminal-notifier >/dev/null; then
  echo "  terminal-notifier 사용 (알림을 누르면 대시보드가 열려요)"
else
  echo "  기본 알림(osascript)을 써요. 알림을 눌러 대시보드를 열려면: brew install terminal-notifier"
fi

say "4/5 launchd 등록 (1분마다, 실행 시간대는 config.json 의 schedule · 기본 평일 8~19시)"
mkdir -p "$HOME/Library/LaunchAgents"
PATHS="$(dirname "$NODE"):$(dirname "$EGO"):$(dirname "$CLAUDE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/run.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ExitTimeOut</key><integer>600</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$PATHS</string><key>LANG</key><string>ko_KR.UTF-8</string></dict>
  <key>StandardOutPath</key><string>$DIR/launchd.out</string>
  <key>StandardErrorPath</key><string>$DIR/launchd.err</string>
</dict>
</plist>
EOF
launchctl bootout "$GUI/$LABEL" 2>/dev/null || true
launchctl bootstrap "$GUI" "$PLIST"
launchctl enable "$GUI/$LABEL"
echo "  등록했어요: $PLIST"

say "5/5 확인"
"$NODE" "$DIR/run.mjs" --check
"$NODE" "$DIR/run.mjs" --test-notify
cat <<'EOF'

설치가 끝났어요. 남은 일:
  · ego 브라우저에서 그룹웨어에 로그인해 두세요.
  · 알림이 안 보이면: 시스템 설정 > 알림 에서 terminal-notifier(또는 스크립트 편집기) 알림을 켜세요.
  · 지금 바로 한 번 돌려 보려면: node run.mjs --now
  · 실행 기록: run.log
EOF
