# 20-08 생산 지명 metadata 연결

현재 기준은 소규모 셀 병합 **이후** catalog `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`다. geometry·topology·영토 ID·운영 부모·seed lineage는 기존 기준을 유지한다. 전체 catalogRef와 manifest byte pin은 `data/runtime/geography/current.json`에 있으며, 선택된 metadataRef는 `geography-metadata-ref-v1 / d10c6db6e6c56bc2c2c53ee26fb281a042b31d16592d45960814f90028158fbf`다. 이 registry는 지명 자료만 선택하며 operational catalog current와 별개다.

## 서버 조회

```ts
import {loadProductionGeography} from '@/lib/geography/production-geography.server';
import {loadOperationalCatalog} from '@/lib/world/operational-catalog.server';
import {executeGeographyRead} from '@/lib/geography/state-province-read';

const loaded = await loadProductionGeography({catalogRef: loadOperationalCatalog().ref, metadataRef: null});
if (loaded.status !== 'available') throw Error(JSON.stringify(loaded.diagnostics));
const result = executeGeographyRead(loaded.snapshot, {
  operation: 'search', sourceCountryId: null, kind: 'source-region', query: '청진',
  reference: null, page: {offset: 0, limit: 128},
});
```

`metadataRef:null`은 생산 registry 선택을 요청한다. 정확한 ref를 전달하면 선택된 버전과 다를 때 stale로 거부한다. 이미 준비된 턴은 보관한 snapshot/index로 계속 읽는다. 파일 경로는 클라이언트에서 받지 않는다. 전체 catalogRef, registry 경로/버전, 저장 bytes의 hash·크기, 128 MiB 해제 한도, schema/content hash, 독립 admission과 실제 catalog membership을 차례로 검사한다. 원본 polygon이나 builder를 호출하지 않는다.

`POST /api/world/regions`의 `{mode:'geography',catalogRef,metadataRef,request}`도 위 조회를 사용한다. `request`의 필수 nullable 필드는 생략하지 않는다. search/list/inspect/members의 의미는 [consumer 계약](state-province-consumers-v1.md)을 따른다. 현재 operational catalog의 기존 region 요청도 metadataRef 생략 시 registry의 canonical state adapter를 사용한다. 이전 catalog의 기존 참조 경로는 유지한다.

State는 기존 검증된 운영 광역 부모이고, Province는 기존 게임 영토 ID 하나다. SourceRegion은 하나의 원본 feature와 연결된 여러 province의 이름 묶음이다. 세 identity를 subdivisionId로 캐스팅하지 않는다. 기존 subdivision reference는 부모와 정확한 셀 집합의 crosswalk로만 연결된다. countryId/sourceCountryId 필터는 원본 분류이고 현재 actor·owner·controller가 아니다.

## 턴 준비와 보존

게임 start 시 승인된 snapshot/index를 전달하고, prepare-turn에서 비동기 로드 후 `session.setPreparationGeography({snapshot,regionIndex})`로 서버 객체를 공급한다. 새 prepare는 base pair·targetDate·전체 catalogRef+metadataRef를 캐시 키로 사용한다. 이미 준비된 요청의 provider와 validator는 retained snapshot을 사용하며, 명시적인 새 prepare나 world/simulation 변경 이후 오래된 context를 거부한다. 진행 중 턴에서는 snapshot 교체를 거부한다.

별칭 갱신은 world/simulation, revision, queue, history를 변경하지 않는다. 개발 재로딩으로 남은 이전 session 구현도 삭제하거나 새 게임으로 교체하지 않는다. 실제 사용자 게임을 검증에 사용하지 않았다. 생산 smoke는 별도 서버·브라우저·새 session에서 실행한다. Next tracing에는 선택된 registry·manifest·metadata gzip·admission gzip만 추가했다. 생산 런타임은 maintenance 보고서를 selector로 사용하지 않는다.

## 실제 검증과 제한

247개 국가, province 8,004개, state 4,201개, 원본 묶음 7,399개다. 현재 fine 국가 CHN/KOR/PRK와 coarse 244개 국가 전부를 C의 독립 `validateCountryMetadataInput`에 국가별로 봉인하여 검증했다. 국가 준비 입력의 metadataRef는 발행된 전체 metadataRef로 재사용하지 않는다.

- 청진·청진시·Chongjin City·Chongjin은 PRK의 동일 원본 묶음/알려진 셀 1개로 연결된다.
- 내몽골·Inner Mongolia는 같은 state/알려진 셀 48개다. 별칭은 미확정 광역 소속을 확정하지 않는다.
- 중구는 KOR의 서로 다른 원본 후보 6개다. 태안군·Taean-gun은 원본 하나/알려진 셀 3개다.
- 미확정 부모 1,436개는 null/unassigned로 유지한다. 파생 표시 이름은 76개이며, 그중 69개가 source-free다. 나머지 7개도 공식 이름을 만들지 않는다.
- 실제 state/원본 묶음 coverage는 fine partial 또는 coarse unsupported이며 독립 complete witness가 없다. 알려진 membership을 모두 읽어도 공식 범위 complete를 뜻하지 않는다. legacy 행동 materialization은 이 범위에 대해 unsupported다. 기존 효과 합계 512개 상한과 권한·전선·원자적 commit 검증은 유지한다.
- 검색 결과 제한/truncated와 실제 동명 ambiguity는 별도 필드다. 공간 표현 ‘북한 북부’, ‘휴전선 인근’은 사전에 추가하지 않는다.

실제 자료의 별칭 이전 20-03 출력과 현재 출력은 catalog/주·셀·부모·원본 identity 및 membership/coverage가 같다. 작은 fixture는 위반 입력(누락·중복·부모 충돌·원본 오류·거짓 complete), metadata 캐시 분리와 prepared 중 버전 전환을 검증한다. 실제 API와 scripted provider는 동일한 canonical 응답/미확정 정보를 반환하며 외부 AI를 호출하지 않는다.

생산 합류 결과는 [20-08 보고서](../../reports/maintenance/prompt20-08-integration.json), 최종 통합 검사와 남은 제한은 [20-09 완료 기록](../../reports/maintenance/prompt20-completion.md), 후속 국가 준비 계약은 [국가별 인계 문서](country-metadata-handoff-v1.md)를 참조한다. 다음 국가 추가는 별도 요청 범위다.
