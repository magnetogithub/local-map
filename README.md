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

전 세계 미세 경계를 한 번에 구현하지 않고, 일반 개발을 진행하면서 요청한 국가만 추가합니다. "일본 미세 국경 구현해"처럼 국가를 지정하면 [국가 지정형 개발 지침](prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt)에 따라 **레퍼런스 조사부터** 시작합니다. 현재 한국·북한 전용 생성기를 그대로 재실행하는 방식이 아니라, 활성 카탈로그와 기존 fine 국가를 보존하는 증분 연결이 필요합니다.

기본 게임은 `catalog-v3-prompt19-korea-bd5f69398db196fa244d`을 사용합니다. 전체 4,718개 영토와 17,238개 경계이며 한국 322개·북한 194개입니다. 한국·북한은 시군구 원본을 기준으로 하고, 정합한 미세 구역들의 공유 경계에서 광역선·국경·해안선을 만듭니다. 다른 245개국의 4,202개 coarse 영토는 그대로입니다. 구 전 세계 92만 격자 셀은 제거했으며 새 게임으로 시작합니다.

현재 지도 배포 자료는 `data/derived/prompt19/mixed-world-v2-bd5f69398db196fa244d`, 무결성 포인터는 `data/runtime/operational-catalog/current.json`입니다. 큰 공동 입력 스냅샷은 Git LFS로 보관하므로 복제 후 `git lfs pull`로 받습니다. `npm run data:korea`는 미세 구역을 검증된 광역 소속에 연결하고, 국경·해안 잔여 띠를 정합한 뒤 독립 기하 검증을 실행합니다. `npm run data:world`는 통과 보고서와 입력의 해시가 일치할 때만 패키징하며 격자를 생성하지 않습니다. 검증은 `node scripts/verify-prompt19-mixed-world.mjs`와 `node scripts/verify-prompt19-fine-macro-world.mjs`로 재현합니다. 구 생성·복구 명령은 `docs/archive/prompt15/retired-grid-tooling`에 실행할 수 없는 `.txt` 기록으로 보존했습니다.

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
