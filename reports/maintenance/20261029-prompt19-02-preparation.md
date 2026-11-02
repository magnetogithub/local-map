# Prompt 19-02 준비 — 완료

2026-10-29 (Asia/Seoul). C가 공용 생성기·국가 외곽 기준·A/B 분기 출력 계약을 준비했다. **19-02A/B 실제 원본 확보와 국가 후보 생성, 최종 catalog 연결, 19-03은 시작하지 않았다.**

- 공통 계약: `reports/maintenance/prompt19-handoff.json`. 실행 안내: `docs/automation/prompt19-02-preparation.md`.
- 19-01의 coarse catalog/index identity와 구 격자 전용 루트 부재를 확인했다. 운영 catalog는 `catalog-v3-prompt19-coarse-v1`, 247개국·4,231개 영토·15,955개 edge로 유지된다.
- `data/derived/prompt19/baseline-v1/`에 기존 KOR/PRK 국가 외곽·coarse 부모·국가 경계를 좌표 변경 없이 추출하고 해시를 고정했다. 4개 파일 391,337 bytes와 index 581 bytes이다. KOR 18개·PRK 11개 coarse 부모, 국가 외곽 component 53개·10개, KOR–PRK 공유 경계 3개 chain(기존 계산 203.70223384284085km)을 보존했다. 한국의 별도 국가-source 섬 component도 보존한다.
- `scripts/prepare-prompt19-country.mjs`와 공용 core/files helper를 준비했다. 실제 원본·정규화 입력·adapter·baseline·공용 코드 identity, 허가·행정 단계·자료 시점, 국가별 물리 경로 격리를 검사한다. 정규화 입력은 검사한 bytes를 그대로 처리한다.
- 실제 source component와 기존 coarse 부모를 교차하여 국가 내부 local ID·명시 membership·내부 adjacency 후보를 만든다. 전역 ID/ordinal/catalogRef, 최종 seed/runtime, 국경 이동은 C의 합류 범위로 남긴다. gap·overlap·hole/island 누락·미세화 부족은 통과시키지 않으며 잔여영역은 진단으로만 남긴다.
- KOR/PRK의 원본·source-lock·후보·보고서 및 국가별 adapter 경로를 분리했다. A/B가 공유 생성기를 복제하거나 국경·전역 ordinal을 독립 확정하지 않는 계약이다.

검증은 13개 테스트 통과(작은 geometry/계약 fixture 8개, 실제 양국 baseline 읽기 검사 2개, 경로·junction·덮어쓰기 검사 3개), 새 스크립트 7개 lint 0 errors/0 warnings이다. Windows sandbox는 junction 생성을 차단하여 그 검사는 sandbox 밖에서 `.tmp` fixture에 한정해 수행했다. 읽기 검토에서 지적된 verified Buffer 재사용과 물리 경로 검사 순서를 보완했다.

모든 계약 pin을 현재 bytes와 대조했다. 세부 source-lock이 없으면 후보 디렉터리를 만들기 전에 실패하고, KOR/PRK 외 국가는 거부함을 확인했다. 현재 runtime 포인터가 바뀌지 않았고 실제 국가 후보가 생성되지 않았음도 확인했다. 앱 코드는 수정하지 않아 서버·브라우저·build나 기존 169개 앱 테스트를 다시 실행하지 않았다.

현재 로컬 자료는 양국 모두 ADM1 수준이며 실제 미세 원본은 아직 확보되지 않았다. 다음 분기 19-02A/B가 해당 국가 원본의 단계·허가·적용 시점을 확인/확보한 뒤 공용 CLI를 사용한다. 원본 부족·외곽 불일치가 생기면 자료와 위치를 인계하고 구 격자나 이름만 바꾼 ADM1으로 대체하지 않는다. 국가 후보의 ready 상태는 최종 19-02 연결 또는 실제 플레이/성능 통과를 뜻하지 않는다.
