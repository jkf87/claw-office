#!/bin/zsh -l
# Claw Office 새 빌드(dist/)를 OpenClaw 게이트웨이에 반영하고, Paseo 데몬을 켠다.
# 결과는 ~/claw-office/.update.log 에도 남는다.
cd "$(dirname "$0")" || exit 1
LOG="$PWD/.update.log"
exec > >(tee "$LOG") 2>&1
echo "== $(date '+%F %T') claw-office 업데이트"
echo "== 설치할 빌드: $(grep -o 'control-ui/[0-9a-f]*' openclaw.plugin.json | head -1)"

echo "\n== 1) Paseo 데몬"
command -v paseo >/dev/null || npm install -g @getpaseo/cli || echo "!! paseo 설치 실패"
paseo daemon start 2>&1 | tail -3
sleep 3
paseo status 2>&1 | grep -E "listen|localDaemon|providers|connectedDaemon" | cut -c1-200

echo "\n== 2) 플러그인 설치 (저장만 되고 '적용 안 됨'이 떠도 다음 단계 재시작에서 반영돼요)"
openclaw plugins install . --force --accept-capabilities 2>&1 | tail -4

echo "\n== 3) 게이트웨이 재시작 (저장된 새 빌드로 다시 뜸)"
openclaw gateway restart 2>&1 | tail -4
sleep 8
openclaw gateway status 2>&1 | tail -6

echo "\n== 4) 설치된 빌드 확인"
grep -o 'control-ui/[0-9a-f]*' ~/.openclaw/extensions/claw-office/openclaw.plugin.json 2>/dev/null | head -1 || echo "(확장 폴더 위치가 달라 확인 못 함)"
echo "\n== 끝. 브라우저에서 Claw Office 탭을 새로고침(Cmd+Shift+R) 하세요."
