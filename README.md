# Pax Local

2020년 1월 1일 OTL 기준의 로컬 우선 PC 지도 프런트엔드입니다. 국가 검색(한국어·영어·ISO3), 국가 선택, 플레이 국가 저장/복원, 세계 반복 이동을 지원합니다.

## 실행

```powershell
npm.cmd install
npm.cmd run data:prepare
npm.cmd run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 프로덕션 확인은 `npm.cmd run build` 후 `npm.cmd start`를 사용합니다.

## 지도 데이터

2026-10-30 성능 수정으로 일반 지도 선택에서는 기존 타일을 사용하며 중국 전체 상세 도형을 중복 로드하지 않습니다. 선택한 국가의 별도 상세는 디버그 모드·zoom 7 이상에서 현재 화면 범위만 읽고, 같은 범위는 재파싱·재그리기를 생략합니다. 점령·호버·선택 색상은 한 번의 fill 계산으로 합쳤습니다. 경계·셀 ID·점령 상한은 유지하며, 비교 조건과 실제 프레임·메모리·UI 점령 결과는 [성능 수정 보고서](reports/chn-perf-20261030/performance-report.json)에 기록합니다.

전 세계 미세 경계를 한 번에 구현하지 않고, 일반 개발을 진행하면서 요청한 국가만 추가합니다. "일본 미세 국경 구현해"처럼 국가를 지정하면 [국가 지정형 개발 지침](prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt)에 따라 **레퍼런스 조사부터** 시작합니다. 현재 한국·북한 전용 생성기를 그대로 재실행하는 방식이 아니라, 활성 카탈로그와 기존 fine 국가를 보존하는 증분 연결이 필요합니다.

중국 전체를 추가한 실험 산출물은 `catalog-v3-prompt19-incremental-CHN-95ea496a8aa66910a9a7`이며, 전체 8,005개 영토와 26,273개 경계입니다. 중국은 원본 계열 2,850개의 실제 현급 경계를 바탕으로 3,320개 셀(미세 3,313개·fallback 7개)을 구성합니다. 현재 게임에서 CHN인 영역만 대상으로 삼으며, 다른 국가의 영토는 편입하지 않습니다. 기존 한국 322개·북한 194개의 ID·행정 부모·원본 계보를 보존하고, 중국–북한과 남북 접경은 양측 미세 구역 연결 100%를 유지합니다. 미세·광역·국경·해안선은 같은 공유 partition에서 만듭니다.

중국 자료는 [geoBoundaries의 고정 OSM ADM3 파일](https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09592ced973a3448cf66b6100b741b64c0d/releaseData/gbOpen/CHN/ADM3/geoBoundaries-CHN-ADM3.geojson)입니다. © OpenStreetMap contributors, geoBoundaries / William & Mary geoLab, Lee Beryman / Wambacher의 자료이며 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)의 표시·재배포·파생 데이터베이스 조건을 따릅니다. 메타데이터의 2017년과 원본의 2021년 처리 이력이 섞여 있어, **2020-01-01의 공식 행정 경계를 인증하는 자료는 아닙니다.** 원본 ID를 유지하고, 검증된 광역 부모를 찾지 못한 원본 1,201개는 미확인 소속으로 명시합니다. 서부의 큰 현급 단위는 실제 자료대로 남기며 점령 거리·폭·면적·행정 부모 상한을 완화하지 않습니다. 조사·채택·배제 근거와 직접 출처는 [자료 결정 기록](reports/chn-2020/source-decision.json)에 있습니다.

게임 경계와 원본 행정 사실은 구분합니다. 중국의 fallback 7개는 기존 섬 5개 약 17.30km²와 한정된 해안 잔여 2개 약 4.58km²로, 합계 약 21.89km²를 별도 기록합니다. 해안 잔여가 전혀 없다고 주장하지 않으며 실제 섬이나 국토 구멍을 임의로 지우지 않습니다. 면적·정밀도·잔여 보정의 근거는 [독립 기하 검증](reports/chn-2020/independent-final.json)과 [잔여 분류](reports/chn-2020/final-fallback-classification.json)에서 확인합니다.

중국 산출물은 `data/derived/prompt19/mixed-world-v2-95ea496a8aa66910a9a7`에 있고, 실제 활성 버전은 `data/runtime/operational-catalog/current.json`이 결정합니다. `scripts/chn-2020/prepare-china.py`와 `incremental-coordinator.mjs`는 해시로 고정한 기존 활성 입력에 중국만 추가합니다. 범용 국가 인자를 제공하는 생성기가 아닙니다. `npm run data:korea`는 기존 한국·북한 생성 흐름이고, `npm run data:world`는 검증된 입력과 proof의 해시가 일치할 때만 패키징합니다. 활성 fine 국가를 빠뜨리는 발행은 거부하므로 기존 명령으로 중국을 coarse로 되돌릴 수 없습니다. 후보는 `--no-activate`로 별도 생성·검증하며, 정확한 재현 명령과 실제 검증·성능·브라우저 결과는 [최종 보고서](reports/chn-2020/final-report.json)에 기록합니다. 큰 공동 입력 스냅샷은 복제 후 `git lfs pull`로 받습니다. 구 전 세계 격자 생성·복구 명령은 `docs/archive/prompt15/retired-grid-tooling`의 실행 불가능한 `.txt` 기록으로 보존했습니다.

새 중국 카탈로그 확인용 로컬 앱 주소는 `http://127.0.0.1:3002`입니다. 기존 실행 중인 게임은 자동 이주하지 않습니다. 활성 포인터를 바꾸기 전에 초기·현재 시뮬레이션, 세계, 전체 undo/redo 이력과 원래 catalog 참조를 Git에서 제외한 `data/runtime/operational-game-checkpoints/`에 무손실 보존하고, 이전 세션 풀을 유지합니다. [보존 영수증](reports/chn-2020/live-game-preservation.json)은 개수·해시 등 메타데이터만 공개합니다. 이전 게임의 계속 진행이나 프로세스 재시작 뒤 자동 복원을 보장하지 않으며, 복구에는 원래 catalog와 비공개 checkpoint가 필요합니다.

한국 자료는 geoBoundaries ADM2(2020, geoBoundaries·City Population, 자료별 CC BY 3.0·배포 CC BY 4.0), 북한은 ADM2(WFP/OCHA ROAP, CC BY 3.0 IGO, 기준연도 2013/2019 메타데이터 불일치)입니다. 한국 원본 228개는 City Population 행정 소속표와 연결하고 군위의 2023년 편입은 2020년에 소급하지 않습니다. 북한 원본 179개는 같은 배포자의 광역 11개와 정확한 포함·합집합 일치를 확인했습니다. 독립된 옛 광역 윤곽을 겹쳐 그리지 않으며, 같은 원본 내부를 가르던 선 713개를 제거했습니다. 국경·해안 잔여 띠는 양의 길이 접촉이나 원본 공유 경계 끝선의 연결 증거가 있을 때만 게임 형상에 합칩니다. 원본 파일은 보존되며 조정 결과를 공식 행정 경계로 주장하지 않습니다. 정합 후 미세 셀은 한국 289개·북한 192개이고, 미귀속 잔여는 한국 33개·북한 2개입니다. 서부의 연결 미분류 구역 두 곳은 실제 파주·연천 접촉선을 기준으로 게임용 분할하여 연결했습니다. 남북 경계 양측 미세 구역 연결은 100%이고 접경 미귀속 구간은 없습니다. 국경·해안 근처의 작은 잔여 고리 8개는 둘레 전체를 공유하는 한 미세 구역에 합쳤고, 동해안과 울진·영덕의 길고 얇은 잔여 띠도 정합했습니다. 원래 미세 구역의 면적은 모두 보존하며, 영광군 누락 같은 큰 공백·실제 국토 구멍·미귀속 섬은 채우지 않습니다. 평시 국경은 검정, 광역선은 흰색, 점령 전선은 금색입니다. 미세 경계는 기본적으로 숨기며 **설정 → 지도 디버그 모드**에서 켭니다. 세계 지도에서는 검정 선이 얇고 옅어지며 확대하면 기존 굵기로 돌아옵니다. 근거는 `reports/maintenance/20261030-western-sector-independent-verification.json`과 `reports/maintenance/prompt19-C/western-sector-2020-mixed-verification.json`에 있습니다.

Natural Earth 공식 GeoJSON을 가공합니다. 최초 화면은 1:50m 국가 데이터, 확대 시 1:10m 국가와 Admin 1 경계를 한 번만 지연 로드합니다. 시아첸 빙하(`KAS`)와 바이코누르 조차지(`KAB`)는 독립 지도 단위에서 제외하고 각각 인도와 카자흐스탄 geometry로 귀속합니다. 정확한 생성 개수와 파일 크기는 `npm.cmd run data:prepare` 출력에서 확인합니다.

원본은 `data/raw`, 재현 가능한 변환은 `scripts/prepare-map-data.mjs`, 브라우저 산출물은 `public/data/maps`에 있습니다. 데이터 출처와 라이선스는 [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/)의 public domain 정책을 따릅니다.

국가명은 Natural Earth의 한국어 이름을 우선하고, 지도용 약칭은 `mapLabelKo`로 별도 관리합니다. 가장 큰 연결 영토에서 내부점을 찾고 PCA 주축과 폴리곤 교차선을 계산해 HOI4형 LineString 기준선을 만듭니다. 화면상 예상 길이와 한글 필요 폭을 조합한 `minZoom` 필터로 대형 국가는 일찍, 소국가는 확대 후 표시합니다. 수동 보정은 `src/data/country-label-overrides-2020.json`에 최소 범위로 관리합니다.

Admin 1 부모는 `adm0_a3 → sov_a3 → gu_a3 → ISO` 순서로 실제 지도 ID와 대조하며 Natural Earth 내부 코드도 정규화합니다. 결과와 누락 검사는 `public/data/maps/admin1-validation-2020.json`에 기록됩니다. 상세 지도 실패는 기본 지도를 막지 않고 재시도할 수 있습니다.

MapLibre 글리프는 로컬 OpenMapTiles Open Sans PBF를 사용하며 한글 표시는 OFL 라이선스의 Noto Sans CJK KR 로컬 폰트로 보완합니다. 외부 지도·글꼴 API는 호출하지 않습니다. 전체 출처는 `data/ATTRIBUTION.md`를 참고하세요.

## 검증

```powershell
npm.cmd run data:prepare
npm.cmd run lint
npm.cmd test
npm.cmd run build
npx.cmd playwright test
```

Playwright는 개발 서버를 자동 실행하고 1280×720, 1440×900, 1920×1080, 2560×1440 데스크톱 흐름과 플레이 국가 복원을 확인합니다. 개발 빌드에서만 `window.__PAX_MAP_DEBUG__` 읽기 전용 인터페이스가 제공됩니다.

`renderWorldCopies: true`와 현재 중심에 가장 가까운 ±360° 경도 사본 계산을 사용하므로 날짜변경선을 지나 계속 이동할 수 있습니다. 선택·호버·플레이 강조는 source 재생성 없이 feature-state와 layer filter로 갱신됩니다.

중국 성급선은 일반 모드의 흰색 표시로 복원했습니다. 기존 OSM·geoBoundaries 성급 원본과 전체 fine family를 대조한 표시 전용 그룹이며, 공식 행정 부모나 점령 제한을 바꾸지 않습니다. 994개 기존 공유 edge만 사용하고 현·군 경계는 계속 디버그에서만 표시합니다. 미확정 12개 family와 원본 없는 7셀은 임의 배정하지 않았습니다. [독립 검증](reports/chn-province-20261030/verification/independent-v2.json)과 [실제 화면](reports/chn-province-20261030/browser/after-china.png)을 참고하세요. 같은 게임 client를 유지한 표시 갱신도 검증했습니다.

[전 세계 확장 분석](reports/world-micro-scale-20261030/scaling-audit.json)은 중국과 같은 면적당 밀도일 때 약 5.2만 셀로 추산합니다. 이는 실제 세계 후보가 아니며, 현재 전체 상태 복사·검색·해시 및 저배율 렌더 구조를 그대로 확대해도 된다는 뜻은 아닙니다. 국가별 증분 개발 정책은 유지합니다.

지도 디버그 모드의 미세선은 **커서 아래 나라와 직접 육상 접경국**에서만 표시합니다. 선택한 나라는 이 범위에 영향을 주지 않으며, 바다나 지도 밖으로 나가면 미세선을 숨깁니다. 범위는 현재 지도 소유·통제 표시와 실제 양측 육상 incidence로 구하고 캐시합니다. 고배율 정밀 검사는 호버 국가의 보이는 영역 중 분할 상세 파일이 있는 경우만 읽으며, 다른 국가는 기존 정밀 벡터선을 사용합니다. 기본 PBF 자체에 포함된 비대상 미세 geometry를 제거하는 전송 구조 변경은 별도 작업입니다.
