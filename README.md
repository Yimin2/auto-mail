# auto-mail

그룹웨어(IBM/HCL Domino 기반) 메일을 1분마다 확인해서, 새 메일이 오면 Claude가 요약하고
**할 일 대시보드**와 Windows 알림으로 알려 주는 개인용 자동화입니다.

- 새 메일 확인은 토큰을 쓰지 않습니다. Claude는 새 메일이 있을 때만 실행됩니다.
- 첨부(PDF·PPT·Word·Excel)는 요약에 쓰고 바로 지우고, 메일 본문 사본은 7일 뒤 지웁니다.
- 요약은 영구 보관합니다(45일 지난 것은 `data/archive/YYYY-MM.json`).

## 흐름

```
작업 스케줄러 (평일 08:00~19:00, 1분마다)
  └ run.vbs → run.ps1
      1. collect.mjs   ego 브라우저 로그인 세션으로 메일 API 호출 → inbox/에 본문·첨부 저장 (토큰 0)
      2. 새 메일이 있으면 Claude CLI 요약 (읽기 전용, JSON)  ← summarize-prompt.md
      3. build.js      data/mails.json 저장 → dashboard.html 생성, 첨부 삭제
      4. markread.mjs  그룹웨어에서 읽음 처리
      5. Windows 알림 (누르면 대시보드)
      + 아침 9시 브리핑, 오후 3시 마감 임박 알림, 본문 7일 뒤 삭제, 요약 연속 실패 시 30분 휴식
```

## 대시보드

- 처리할 일(마감 순, 체크하면 완료) · 지켜볼 일(참조 메일, 담당자 표시) · 완료한 일(7일)
- 할 일마다 근거 파일·위치 칩, 마우스를 올리면 근거 원문
- 반복 메일 묶음(지난 회차 대비 달라진 점) · 대화(Re:/FW:) 묶음
- 광고·뉴스레터는 접힌 칸에 따로, 의심 메일은 의심 해제/위험 표시
- Ctrl+F 로 검색

## 설치

1. 필요한 것: Windows, Node.js, ego lite 브라우저(`ego-browser` CLI), Claude Code CLI
2. `config.example.json` 을 `config.json` 으로 복사해서 내 값으로 채웁니다. **`config.json` 은 git에 올라가지 않습니다.**

   | 키 | 설명 |
   |---|---|
   | `gwHost` | 그룹웨어 주소 (예: `https://groupware.example.com`) |
   | `mailDb` | 내 메일함 DB 경로 (예: `/mail/server/mailbox.nsf`) |
   | `mailViewPath` | 메일 한 통을 그룹웨어 화면으로 여는 주소 형식 (`{mailDb}`, `{unid}` 치환) |
   | `meMatch` | 수신/참조 목록에서 나를 찾는 정규식 (사번·메일 ID·이름) |
   | `userName` · `userLabel` | 요약 지침에 들어갈 내 이름 · "회사 팀 이름" |
   | `claudePath` | Claude CLI 경로 |

3. ego 브라우저에서 그룹웨어에 로그인해 둡니다.
4. (선택) 디자인 시스템 적용: `node tools/make-ds.js <디자인 시스템 project 폴더>` → `ds/` 생성
5. Claude CLI 로그인: `claude` 실행 후 `/login`
6. 작업 스케줄러 등록 (평일 08~19시, 1분 간격):

   ```
   schtasks /Create /TN "GW-Mail-Summary" /TR "wscript.exe \"<이 폴더>\run.vbs\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 08:00 /RI 1 /DU 11:00 /IT /F
   ```

## 보안

- 요약하는 Claude는 `Read` 도구만 허용(쓰기·삭제·명령 실행 불가). 메일 속 지시문은 따르지 않고 경고로 표시합니다.
- 메일 내용은 요약을 위해 Claude(Anthropic)로 전송됩니다. 회사 보안 정책을 먼저 확인하세요.
- 메일·요약·로그·설정 파일은 모두 `.gitignore` 로 제외되어 있습니다.

## 파일

| 파일 | 역할 |
|---|---|
| `run.ps1` / `run.vbs` | 1분 주기 실행 진입점 |
| `collect.mjs` | 새 메일 수집 (본문·첨부·office 텍스트 추출) |
| `summarize-prompt.md` | Claude 요약 지침 |
| `build.js` | 데이터 저장·보관, 브리핑 집계, 대시보드 생성 |
| `markread.mjs` / `marks.mjs` | 그룹웨어 읽음 처리 / 대시보드 체크 기록 읽기 |
| `tools/make-ds.js` | 디자인 시스템 → CSS 변환 |
