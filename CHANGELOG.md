# 변경 기록

## 0.2.0 — 2026-10-28

Claude Code·Codex 세션을 [Paseo](https://paseo.sh)로 다루는 판입니다. 오피스에서 보낸 메시지가 지금 돌고 있는 그 세션에 들어가고, 권한 요청에도 오피스에서 바로 답합니다.

### 새로 된 것

- **Paseo 대화 창.** 직원을 클릭하면 오른쪽에 대화 창이 열리고, 같은 세션에 바로 입력합니다. `claude --resume`으로 두 번째 프로세스를 띄우지 않으므로 대화가 갈라지지 않습니다.
- **권한 요청 버튼.** 🔔 받은함과 대화 창에서 허용 / 이 세션은 편집 자동 허용 / 거부로 답합니다.
- **새 세션 시작.** ＋ 일 맡기기에서 컴퓨터를 고르고 폴더(절대 경로)를 적어 Claude Code·Codex 세션을 새로 띄웁니다.
- **세션 가져오기.** 터미널에서만 돌던 세션을 클릭하면 Paseo로 가져와서 엽니다. 다른 터미널에서 아직 쓰는 중인 세션은 건드리지 않고 알려 줍니다.
- **권한 모드.** 대화 창 위에서 세션별로 매번 묻기 / 편집 자동 허용 / 자동 검토 / 모두 허용 / 계획만을 고릅니다. 오른쪽 위 "새 세션:"으로 기본값(처음엔 자동 검토)을 정하고, "지금 세션에도 적용"으로 연결된 모든 컴퓨터의 Claude Code 세션을 한 번에 바꿉니다. 모두 허용은 한 번 더 눌러야 적용됩니다.
- **여러 컴퓨터.** `~/.claw-office/paseo.json`에 데몬 목록을 적습니다(예시 `paseo.example.json`). 없으면 이 컴퓨터의 데몬만 씁니다.
- **`update-plugin.sh`.** Paseo 데몬 켜기 → 플러그인 설치 → 게이트웨이 재시작을 한 번에 하고, 결과를 `.update.log`에 남깁니다.

### 바뀐 것

- 세션을 클릭해도 게이트웨이 웹 채팅 화면으로 넘어가지 않습니다. Claude Code·Codex는 Paseo 대화 창(기본)이나 터미널 패널로, OpenClaw 세션은 터미널 패널의 TUI로 열립니다. 오른쪽 위 "열기: Paseo / 터미널"로 고르고, 브라우저마다 기억됩니다.
- 예전의 열기 방식 고르기 창과 터미널 탭의 💬(채팅 화면 이동) 버튼을 뺐습니다.
- README를 새로 썼습니다. 설치, Paseo 연결, 사용법, 내 컴퓨터 구성에 맞추기, 소스 구조가 들어 있습니다.

### 고친 것

- 실행 중인 게이트웨이에 플러그인을 다시 올릴 때 "plugin host cleanup timed out"으로 교체가 멈추던 문제. 플러그인을 내릴 때 SSH 읽기와 Paseo 연결을 닫습니다.
- OpenClaw 2026.10.5에서 런타임 의존성이 `node_modules`에 없다며 플러그인이 켜지지 않던 문제. 번들되는 `@getpaseo/client`를 `devDependencies`로 옮겼습니다.
- Paseo 클라이언트의 CommonJS 의존성이 Node 내장 모듈을 `require()`해서 백엔드 번들이 깨지던 문제(`createRequire` 배너 추가).

### 올릴 때

```sh
cd ~/claw-office && git pull && ./update-plugin.sh
```

그다음 Claw Office 탭을 강력 새로고침(Cmd+Shift+R)합니다. 다른 컴퓨터 세션을 Paseo로 다루려면 그 컴퓨터에도 `paseo daemon start`를 하고 `~/.claw-office/paseo.json`에 적어 주세요.

### 알려진 것

- 컴퓨터 목록(`src/machines.ts`, `src/stats.ts`, `src/control-ui.ts`의 `HOME`)이 코드에 들어 있습니다. 다른 구성은 README "내 컴퓨터 구성에 맞추기"를 보세요.
- `npm run typecheck`는 `vendor/` 쪽 기존 타입 오류 26개를 그대로 냅니다(`src/`는 0개).

## 0.1.0

OpenClaw Control UI 안의 3D 사무실. 이 컴퓨터와 tailnet 컴퓨터들의 OpenClaw 에이전트·Claude Code·Codex·GJC·AGY 세션을 직원으로 보여 주고, 컴퓨터 상태 보드와 터미널 패널을 둡니다. 3D 사무실은 [Agent Office](https://github.com/AgentSystemLabs/agent-office)(MIT)를 그대로 씁니다.
