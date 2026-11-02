# 16-08 기존 게임 화면·실제 턴 경로 통합

새 게임의 기본 진입점 `/`와 `/game`을 지정된
`catalog-v3-56fc6c79c216e6bd1a11`에 연결했다. 16-03의 atomic runtime,
16-05의 지도 consumer와 16-07의 provider·전선 검증을 실제 게임 경로에서
함께 사용한다. 기존 원본·승인 산출물과 다른 작업의 변경은 보존했다.

## 게임과 서버

- `/api/simulation/game`은 기존 runtime으로 로컬 게임을 시작하고 행동 등록·취소,
  국가 선택, undo/redo, 재시작과 턴 준비를 처리한다. world·simulation·history의
  authoritative pair는 서버에 있다. 서버 재시작이나 새로고침 후 복원하는 저장
  기능은 추가하지 않았다. 게임은 메모리에만 두며 종료 시 해제하고 장기 유휴
  세션을 만료시킨다.
- 초기 cell 상태는 16-02 factory에서 이전 부모의 실제 owner/controller를
  상속한다. 별도 gzip 응답은 기존 catalog 순서의 ID만 전달한다. 초기 화면에
  전 세계 상세 polygon을 보내지 않는다.
- `/api/simulation/turn`은 게임 식별자를 HTTP header로 받고 해당 게임의 현재
  world와 서버가 만든 context를 대조한다. 기존 `{turnId, context}` JSON 계약은
  유지한다. 임의 world·authority를 JSON에 넣는 경로는 열지 않았다.
- provider 결과는 같은 현재 world에서 frontier를 재선택한 뒤
  `createCatalogTurnPlan` → `runtime.commit`으로 한 번에 반영한다. 잘못된
  ID·revision·scope·authority, cap 초과나 실패한 provider는 부분 commit하지 않는다.
  production DEBUG 제한과 기존 provider 예산·Retry 정책은 유지한다.
- 모델용 context에서 잘린 권한 ID 목록을 실제 권한 범위로 오인하지 않도록,
  provider의 host 검증에는 현재 simulation의 완전한 권한 범위를 전달한다.
  이 값은 모델 context나 클라이언트 입력으로 직렬화하지 않는다.
- 처리 중 다른 변경을 막고, 응답 유실 후에는 최신 snapshot을 다시 읽는다.
  이미 commit한 턴은 실패로 오인해 중복 실행하지 않는다. 스트림 예외도 정상
  sequence의 실패 이벤트로 전달한다.

## 화면과 지도

- 기존 국가 선택·검색·행동창·HUD·날짜·뉴스·주요 사건·화면 설정을 공유한다.
  국가 패널의 소유·통제·피점령 수는 실제 cell 상태에서 계산하고 이후 delta로
  갱신한다. 구형 consumer와 asset 경로도 제거하지 않았다.
- 브라우저는 서버 snapshot의 미러를 유지한다. 변경 cell의 before/after와
  revision을 확인한 뒤 불변 snapshot을 공개하며, 별도 영토 변경을 결정하지 않는다.
- `OperationalWorldMap`은 v3 consumer를 mount하고 실제 state delta를
  `updateWorld`에 전달한다. 점령·후속 진격·해방·양도·undo/redo가 같은 경로를
  사용한다. 통제국 색상과 공유 edge의 현재 controller 차이로 점령색·전선을 표시한다.
- 선택한 국가의 exact detail과 변경 cell·전선만 필요할 때 읽는다. 기존
  국가 이름·카메라·수도 presentation seed를 재사용하고, 국호 변경은 현재
  이름을 표시한다. 행정선은 zoom 4부터, 합성 cell 격자는 기본 숨김이다.

## 확인

- `tsc --noEmit` 및 변경 TypeScript 파일 ESLint 통과.
- 기존 지도 consumer·provider·territorial runtime·행동 UI와 새 통합 테스트를
  필요한 묶음으로 실행했다. UI controller의 행동 등록부터 서버 commit,
  후속 진격, undo/redo delta와 지도 projection 일치가 통과했다.
- 추가로 context 위조, stale revision, 잘못된 ID, 처리 중 동시 변경,
  취소 후 잠금 해제, commit 후 응답 유실 복구, 재시작과 잘린 권한 context를 확인했다.
- 기존 로컬 dev 서버의 `/`가 새 화면 진입점을 컴파일하고 HTTP 200을 반환했다.
  실제 `/api/simulation/game`에서 923,443개 cell·247개국을 초기화하고,
  대한민국 선택·대표 문장 등록·턴 context 준비를 확인했다. 지도 cell 인덱스는
  같은 catalog의 923,443개 ID를 gzip HTTP 200으로 전달했다.
- 외부 AI API는 호출하지 않았다. production build와 대표 요청의 실제
  브라우저 점령색·전선 확인은 16-09에서 수행한다. 사용자 직접 플레이가
  검증되었다고 기록하지 않는다.

## 실행

`npm run dev` 후 `http://localhost:3000`에서 대한민국을 선택한다.
국가 행동에 `북한에 전쟁을 개시하여 휴전선 인근을 점령`을 등록하고 시간을
진행한다. 후속 요청은 `현재 전선에서 북한 쪽으로 제한적으로 더 진격`처럼
입력한다. 행동창의 undo/redo로 날짜와 통제 상태를 함께 되돌릴 수 있다.
일반 요청은 기존 권한·인과와 불확실한 판정을 따른다. 개발용 확정 효과는
기존 `PAX_SIMULATION_DEBUG_MODE=1`과 `[DEBUG_WORLD_EFFECT]` 정책을 그대로
사용하며 production에서는 권한 우회가 허용되지 않는다. 새 게임은 새로고침
또는 `/`의 국가 선택 흐름으로 시작한다.
