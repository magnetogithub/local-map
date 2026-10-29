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

기본 게임은 `catalog-v3-prompt19-korea-416fa2c3b263ab7a13be`을 사용합니다. 전체 6,530개 영토와 21,908개 경계이며 한국 1,181개·북한 1,147개입니다. 한국을 읍면동에서 시군구 수준으로 조정해 실제 행정경계에 근거한 구역의 평균 면적을 북한과 비슷하게 맞췄습니다. 다른 245개국의 4,202개 coarse 영토는 그대로입니다. 구 전 세계 92만 격자 셀은 제거했으며 새 게임으로 시작합니다.

현재 지도 배포 자료는 `data/derived/prompt19/mixed-world-v2-416fa2c3b263ab7a13be`, 무결성 포인터는 `data/runtime/operational-catalog/current.json`입니다. 큰 공동 입력 스냅샷은 Git LFS로 보관하므로 복제 후 `git lfs pull`로 받습니다. `npm run data:korea`는 잠긴 한국 ADM2·북한 ADM2 원본과 고정 국가 외곽의 공동 경계 분할을 준비하고, `npm run data:world`는 검증된 공동 산출물을 패키징하며 격자를 생성하지 않습니다. 검증은 `node scripts/verify-prompt19-mixed-world.mjs`로 재현합니다. 구 생성·복구 명령은 `docs/archive/prompt15/retired-grid-tooling`에 실행할 수 없는 `.txt` 기록으로 보존했습니다.

한국 자료는 geoBoundaries ADM2(2020, geoBoundaries·City Population, 자료별 CC BY 3.0·배포 CC BY 4.0), 북한은 ADM2(WFP/OCHA ROAP, CC BY 3.0 IGO, 기준연도 2013/2019 메타데이터 불일치)입니다. 한국 원본은 실제 228개 구역이며 메타데이터의 229개 표기와 다른 점을 기록했습니다. 원본 내부 소속을 확인한 면만 행정구역으로 인정하고, 원본이 덮지 않는 고정 국가 외곽은 한국 643개·북한 488개 coarse 잔여로 별도 보존합니다. 실제 행정경계 기반 셀은 한국 538개·북한 659개이며 평균 면적은 약 179㎢·184㎢입니다. 평시 국경은 검정, 점령 전선은 금색이며 미세 내부 경계선은 숨깁니다. 근거는 `reports/maintenance/20261029-map-boundaries-and-korea-scale-fix.json`과 `reports/maintenance/20261029-kor-adm2-independent-verification.json`을 참고하세요.

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
