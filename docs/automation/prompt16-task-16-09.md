# 16-09 최소 확인·직접 플레이 안내

2026-10-28에 Prompt 16의 최소 확인을 수행했다. 기본 데이터는 지정된
`catalog-v3-56fc6c79c216e6bd1a11`을 그대로 사용한다.

## 확인 결과와 수정

- `node node_modules/typescript/bin/tsc --noEmit` 통과.
- `npm.cmd run build` 통과. 실행 중인 dev 서버와 충돌하지 않도록
  `PAX_BUILD_DIST_DIR=.next-prompt16-build`로 출력을 분리했다.
- runtime·게임 연결·provider·지도 consumer 4개 파일의 31개 테스트 통과.
  부분 점령의 owner/비대상 보존, 잘못된 ID·stale revision의 원자적 실패,
  undo/redo와 지도 projection 복원, 해방·양도 및 권한 검사를 포함한다.
- 변경 TypeScript 파일의 ESLint와 diff 공백 검사 통과.
- 실제 게임 화면에서 대한민국 선택, 행동 등록, 1일 진행을 실행했다.
  북한의 소유 1,283개는 유지되고 통제는 1,283→1,275개로 바뀌었다.
  지도에 북한 내부의 한국 통제색과 이를 둘러싼 전선이 표시됐다.
- undo 후 날짜가 2020-01-01로 돌아가고 북한 통제 1,283개가 복원됐다.
  redo 후 2020-01-02의 점령 턴이 복원됐다. 다음 진격은 현재 상태에서
  이어져 2020-01-03에 누적 16개 cell이 점령되고 북한 통제는 1,267개가 됐다.
- 화면 확인은 기존 개발용 scripted provider를 확장해 수행했다. 실제 catalog
  조회·현재 전선 선택·host 검증·commit·지도 경로를 사용하며 외부 AI API는
  호출하지 않았다. 이 fixture는 대한민국의 북한 접경 점령/후속 진격 확인용이다.
  일반 provider의 자연어 판정이나 사용자 직접 플레이를 검증했다고 기록하지 않는다.

화면 확인 중 실제 요청의 `MALFORMED_REQUEST`를 수정했다. 새 catalog의
잔여 지역 ID가 64자를 넘는데 SimulationContext만 구형 event ID 제한을
사용하고 있었다. 공통 subdivision 참조 규격을 재사용하고, 서버가 전송할
context도 동일한 parser로 정규화했다. 긴 지역 ID를 기존 통합 fixture에
추가해 HTTP 턴 경로의 회귀 검사를 보완했다. ID를 자르거나 catalog를 바꾸지 않았다.

선택·hover·점령 강조의 셀별 antialias 윤곽이 합성 격자처럼 보이는 현상도
보정했다. 실제 경계와 전선은 기존 전용 line layer로 표시하며, 합성 grid
layer는 기본 숨김을 유지한다. 새 페이지에서 선택 강조 표시를 다시 확인했다.

확인 화면: `screenshots/prompt16-partial-front.jpg`.
최초 전선 상세 asset을 읽을 때 대기가 관측됐다. 사용자가 직접 플레이하며
범위·표시 품질·로딩 속도를 확인한 뒤 필요한 부분을 후속 수정한다.

## 바로 플레이하기

일반 게임은 `npm.cmd run dev` 후 `http://localhost:3000`에 접속한다.
이미 서버가 실행 중이면 주소만 연다. 대한민국을 선택한 뒤 국가 행동에
아래 문장을 등록하고 1일 또는 원하는 기간을 진행한다.

1. 첫 점령: `북한에 전쟁을 개시하여 휴전선 인근을 점령`
2. 후속 진격: `현재 전선에서 북한 쪽으로 제한적으로 더 진격`
3. 해방/반환: `북한과 합의해 한국이 점령한 북한 접경 일부를 북한 통제로 돌려준다`
4. 양도: `대한민국이 소유한 북한 접경 영토 일부를 북한에 양도한다`

일반 요청은 기존 권한과 인과에 따른 판정을 받는다. 개발용 확정 효과를
사용하려면 기존 `PAX_SIMULATION_DEBUG_MODE=1` 설정과 문장 앞의
`[DEBUG_WORLD_EFFECT]` 표시를 사용한다. production의 제한은 유지한다.
외부 API 없이 이번 두 점령 요청을 재현하는 확인용 서버는
`http://127.0.0.1:3001`이며 두 문장 앞에 위 DEBUG 표시를 붙인다.

지도 우측 아래 국가 선택에서 북한을 선택하면 해당 위치로 이동한다.
국가 창을 닫고 휴전선 인근을 zoom 6~7 정도로 확대하면 북한 내부로 들어간
통제색과 금색 전선을 볼 수 있다. 영토 클릭 시 하단 범례의 소유·통제도
확인한다. 국가 행동 창의 `마지막 턴 되돌리기`와 `다시 실행`은 날짜와
통제를 함께 복원한다. 새 게임은 새로고침하거나 `/`의 국가 선택 흐름으로 시작한다.

확인용 서버를 다시 띄울 때는 별도 PowerShell에서 다음을 실행한다.

```powershell
$env:PAX_BUILD_DIST_DIR='.next-prompt16-smoke'
$env:PAX_OPERATIONAL_SMOKE='1'
node --max-old-space-size=8192 node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3001
```
