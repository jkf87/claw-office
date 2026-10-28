// Claude Code's permission modes as the office names them, and the one new or imported sessions start in.
// The default lives in this browser (per viewer), like the open-with switch.

export const CLAUDE_MODES: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "매번 묻기", hint: "도구를 처음 쓸 때마다 허락을 받아요" },
  { id: "acceptEdits", label: "편집 자동 허용", hint: "파일 수정은 묻지 않고, 명령 실행 등은 물어요" },
  { id: "auto", label: "자동 검토", hint: "분류 모델이 권한 요청을 보고 안전한 건 알아서 허용해요" },
  { id: "bypassPermissions", label: "모두 허용", hint: "아무것도 묻지 않아요 (믿는 폴더에서만)" },
  { id: "plan", label: "계획만", hint: "읽고 계획만 세우고, 실행·수정은 안 해요" },
];

const LABEL = new Map(CLAUDE_MODES.map((m) => [m.id, m.label]));
/** The office's name for a mode, else the provider's own label. */
export const modeLabel = (id: string, fallback = id) => LABEL.get(id) ?? fallback;

const STORE = "claw-office:default-mode";
const FALLBACK = "auto";

export function defaultMode(): string {
  try {
    const v = localStorage.getItem(STORE);
    return v && LABEL.has(v) ? v : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function setDefaultMode(id: string) {
  try { localStorage.setItem(STORE, id); } catch { /* storage blocked: this visit only */ }
}
