<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 국가별 미세 경계 개발

- 사용자가 특정 국가의 미세 국경/미세 영토 구현을 요청하거나, 해당 작업 맥락에서 국가를 지정하면 [국가 지정형 개발 지침](prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt)을 먼저 읽고 따른다.
- 첫 실질 단계는 대상국의 경계 원본·행정 계층·시점·라이선스 레퍼런스 조사다. 자료를 채택한 다음 구현한다.
- 지정한 국가만 현재 활성 catalog에 증분 추가한다. 이미 구현한 국가를 coarse baseline으로 되돌리거나 전 세계 미세화를 자동 시작하지 않는다.
- 지침 작성·수정 요청에는 문서만 변경한다. 현재 KOR/PRK 전용 스크립트를 국가 인자만 바꿔 실행할 수 있는 범용 도구로 취급하지 않는다.
