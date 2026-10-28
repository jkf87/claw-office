# 기여하기

Claw Office에 관심 가져 주셔서 고맙습니다. 버그 제보, 기능 제안, PR 모두 환영합니다. 이 문서는 개발 환경 준비부터 PR까지의 순서를 적습니다.

## 시작하기 전에

- 버그나 제안은 먼저 [Issues](https://github.com/jkf87/claw-office/issues)에 남겨 주세요. 큰 변경은 이슈에서 방향을 맞춘 뒤 PR을 여는 편이 서로 덜 수고롭습니다.
- 버그 제보에는 OpenClaw 버전(`openclaw --version`), Node 버전, 운영체제, 재현 순서, 그리고 가능하면 브라우저 콘솔 오류나 `.update.log`의 해당 부분을 붙여 주세요. **비밀번호·토큰·IP·홈 경로는 지우고** 올려 주세요.

## 개발 환경

필요한 것: OpenClaw 2026.9.8 이상, Node 24.16 이상. Paseo 기능까지 보려면 `claude`(와 `codex`)가 로그인돼 있어야 합니다.

```sh
git clone https://github.com/jkf87/claw-office.git
cd claw-office
npm install
npm run build        # dist/ 와 openclaw.plugin.json 의 controlUi 경로를 다시 만듦
./update-plugin.sh   # 내 게이트웨이에 설치하고 재시작
```

Control UI에서 **Settings > Labs > Custom plugin UI**를 켜고 Claw Office 탭을 강력 새로고침(Cmd+Shift+R)하면 바뀐 빌드가 보입니다. 실행 중인 게이트웨이에 핫리로드하면 교체가 멈출 수 있으니, 고친 뒤에는 `./update-plugin.sh`로 재시작하는 쪽이 확실합니다.

소스 구조는 [README의 개발 절](README.md#개발)에 표로 있습니다.

## 고칠 때 지킬 것

- **`vendor/agent-office/`는 고치지 않습니다.** [Agent Office](https://github.com/AgentSystemLabs/agent-office)를 `vendor/agent-office/SOURCE_COMMIT`의 커밋 그대로 둡니다. 동작을 바꿔야 하면 `src/`에서 감싸서 바꿉니다. 3D 사무실 자체의 버그는 Agent Office 쪽에 제보해 주세요.
- **`dist/`는 커밋합니다.** 설치하는 사람이 빌드 없이 쓸 수 있도록 빌드 결과를 저장소에 둡니다. `src/`를 고쳤다면 `npm run build`를 돌리고 `dist/`와 `openclaw.plugin.json`을 같은 커밋에 넣어 주세요. 브라우저 번들은 내용 해시 폴더(`dist/control-ui/<hash>/`)로 나가므로, 예전 해시 폴더는 빌드가 지웁니다.
- **의존성 위치.** `dist/`에 번들되는 패키지(Paseo 클라이언트 등)는 `devDependencies`에 둡니다. OpenClaw 2026.10 이후는 `dependencies`에 있는 패키지가 `node_modules`에 없으면 플러그인을 켜지 않습니다.
- **브라우저 코드의 import.** 브라우저 쪽은 OpenClaw SDK의 `control-ui`, `feature-contract` 진입점만 import합니다.
- **화면 글은 한국어로.** 버튼·안내 문구는 지금처럼 짧은 한국어 존댓말로 씁니다(예: "모든 질문에 답을 골라 주세요.").
- **개인 설정은 저장소 밖에.** 데몬 주소·비밀번호는 `~/.claw-office/paseo.json`에만 두고, 예시는 `paseo.example.json`에 가짜 값으로 적습니다. 실제 IP, Tailscale 이름, 비밀번호, 토큰, 홈 경로가 커밋에 들어가지 않게 해 주세요.
- **컴퓨터 목록.** 지금은 `src/machines.ts`, `src/stats.ts`, `src/control-ui.ts`의 `HOME`에 들어 있습니다. 내 구성에 맞추려고 바꾼 값은 PR에 넣지 말아 주세요. 이 목록을 설정 파일로 빼는 PR은 환영합니다.

## PR 전에 확인할 것

```sh
npm run build
npm run typecheck
npm run validate
```

- `npm run typecheck`는 `vendor/` 쪽 기존 오류 26개를 그대로 냅니다. `src/`는 **0개를 유지**해 주세요.
- 내 게이트웨이에 설치해서 바꾼 부분을 실제로 눌러 보세요. 화면이 바뀌었다면 PR에 스크린샷을 붙여 주세요.
- 폰 폭(대화 창이 전체 화면으로 열리는지)과 한글 입력도 한 번 확인해 주세요.

## 커밋과 PR

- 커밋 제목은 영어 명령형 한 줄로, 무엇이 바뀌는지 씁니다(예: `Switch a Paseo session's permission mode from the office`). 본문에는 왜 바꿨는지와 사용자에게 보이는 차이를 적습니다.
- 한 PR에는 한 가지 변경만 담아 주세요.
- 사용자에게 보이는 변경이면 [CHANGELOG.md](CHANGELOG.md) 맨 위에 한 줄 추가해 주세요. 사용법이 바뀌면 README도 같이 고칩니다.
- 커밋 이메일이 공개돼도 괜찮은지 확인해 주세요. 원하지 않으면 GitHub의 noreply 주소(Settings > Emails)를 `git config user.email`로 쓰면 됩니다.

## 라이선스

기여한 코드는 이 저장소의 [MIT 라이선스](LICENSE)로 배포됩니다. `vendor/agent-office/`는 Agent Office의 MIT 라이선스를 따릅니다([NOTICE.md](NOTICE.md)).
