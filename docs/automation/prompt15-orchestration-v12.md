# Prompt 15 총괄 구현 검증 운영 v12

현재 모드는 `manual-prompt14`다. Prompt 14는 별도 창에서 수동 독립 검증하며 이 오케스트레이션은 자동 실행하지 않는다. 자동 14 보완 루프는 폐기했다. 과거 run·판정·후보·배정 기록은 보존한다.

## 실행 경계

`automation/prompt15/config.json`의 실행 모드가 수동이면 `run.mjs start/resume`과 runtime wrapper는 run 생성·latest 변경·retry 기록·app-server/model 호출 전에 거부한다. 실행 중 수동 모드 전환/stop은 해당 컨트롤러의 turn만 중단한다. 수동 결과 접수 자체는 실행을 허가하지 않는다.

14 PASS 뒤 사용자가 재개를 지시하면 독립 검증 결과와 후보를 명시적으로 접수하고 새 run을 A부터 시작한다. 과거 baselinePending run을 자동 변환하거나 네 번의 FAIL을 PASS로 덮어쓰지 않는다. F 통과 후에는 대기하며 게시·cutover·Prompt 16을 시작하지 않는다.

## 48개 독립 태스크의 목표 실행 계약

실행 태스크는 15-01~15-48이다. 기존 8개 checkpoint는 작업 구간이고 최종 통합 승인 경계는 REVIEW A~F다. 태스크마다 별도 배정·보고·독립 검증·재개를 수행하고 PASS일 때만 의존 작업을 해제한다. FAIL은 같은 태스크 보완, BLOCKED는 해당 태스크와 의존 작업 대기다.

현재 실행기는 implementationUnit=review인 기존 모드다. 48개 태스크 스케줄러는 아직 반영되지 않았으며 자동 실행은 manual-prompt14로 정지한다. 아래 도식은 재개 전에 실행기에 반영할 목표 설계다.

```mermaid
flowchart TD
  P14["Prompt 14 수동 독립 검증"] -->|PASS·후보 접수·재개 지시| A["15-01~15-10 · 10개 독립 태스크<br/>audit·복구 작업 분기와 태스크별 검증"]
  A --> RA{"REVIEW A"}
  RA -->|PASS| B0["15-11→15-12→15-13<br/>각 태스크 검증 PASS"]
  B0 --> BF["작업 분기 · 격리 병렬"]
  BF --> B1["15-14 해상도 실험·검증"]
  BF --> B2["15-15 ID 결정성·검증"]
  B1 --> BJ{"합류 · 둘 다 PASS"}
  B2 --> BJ
  BJ --> B3["15-16→15-17 · 각 태스크 검증"]
  B3 --> RB{"REVIEW B"}
  RB -->|PASS| C["15-18~15-24 · 7개 독립 태스크<br/>생성·감사·독립 생성·각 태스크 검증"]
  C --> RC{"REVIEW C"}
  RC -->|PASS| DF["공통 계약 고정 · 작업 분기"]
  DF --> D1["15-25~15-30 · 도구·범위<br/>각 태스크 검증"]
  DF --> D2["15-31~15-35 · migration<br/>각 태스크 검증"]
  D1 --> DJ{"합류 · 두 분기 모두 PASS"}
  D2 --> DJ
  DJ --> DM["통합 작업본 구성"]
  DM --> RD{"REVIEW D · 통합 검증"}
  RD -->|PASS| E0["15-36→15-37→15-38<br/>각 태스크 검증 PASS"]
  E0 --> EF["작업 분기 · 별도 게임·브라우저"]
  EF --> E1["15-39→15-40<br/>북한·후속 진격·각 태스크 검증"]
  EF --> E2["15-41 슬로베니아·검증"]
  E1 --> EJ{"합류 · 모두 PASS"}
  E2 --> EJ
  EJ --> E3["15-42 일반화·검증"]
  E3 --> RE{"REVIEW E"}
  RE -->|PASS| F0["15-43 후보 동결·검증"]
  F0 --> FF["작업 분기 · 동결 후보 읽기 전용"]
  FF --> F1["15-44 세계 감사·검증"]
  FF --> F2["15-45 실제 API·검증"]
  FF --> F3["15-46 브라우저·검증"]
  F1 --> FJ{"합류 · 셋 다 PASS"}
  F2 --> FJ
  F3 --> FJ
  FJ --> F4["15-47 성능 측정·검증 · 단독 실행"]
  F4 --> F5["15-48 복구 준비·검증"]
  F5 --> RF{"REVIEW F"}
  RF -->|PASS| HOLD["후보 보존 · 사용자 지시 대기"]
  classDef gate fill:#fef3c7,stroke:#d97706,color:#111827
  class RA,RB,RC,RD,RE,RF,BJ,DJ,EJ,FJ gate
```

## 태스크별 검증·병렬 작업·합류

각 태스크 검증의 PASS 경로만 다음 태스크로 이어진다. 병렬 작업은 모든 의존 PASS·소유 범위 비중복·게임/브라우저/출력 격리 조건을 만족할 때 최대 2개를 실행한다. baseline 측정 태스크 15-06과 최종 성능 태스크 15-47은 단독 실행한다. 합류는 모든 선행 태스크의 현재 PASS를 기다린다.

### REVIEW A · 10개 독립 태스크

```mermaid
flowchart TD
  ENTRY["수동 14 승인 후보 접수·재개 지시"]
  subgraph G15_1["작업 구간 · 기준·소실 audit"]
    T15_01["15-01<br/>실제 기준 후보와 입력 고정"]
    V15_01{"15-01 검증"}
    T15_02["15-02<br/>전 국가 행정구역 소실 audit"]
    V15_02{"15-02 검증"}
    T15_03["15-03<br/>북한 도 전체 선택 문제 재현"]
    V15_03{"15-03 검증"}
    T15_04["15-04<br/>슬로베니아 원본 lineage와 gap 추출"]
    V15_04{"15-04 검증"}
    T15_05["15-05<br/>런타임 참조·제한 계약 audit"]
    V15_05{"15-05 검증"}
    T15_06["15-06<br/>지도·성능 baseline과 audit 통합<br/>성능 측정 단독 실행"]
    V15_06{"15-06 검증"}
  end
  subgraph G15_2["작업 구간 · 정합·복구 후보"]
    T15_07["15-07<br/>gap 원인 분리 실험"]
    V15_07{"15-07 검증"}
    T15_08["15-08<br/>정합 복구 정책과 허용 한도 고정"]
    V15_08{"15-08 검증"}
    T15_09["15-09<br/>슬로베니아 행정 복구 후보 검증"]
    V15_09{"15-09 검증"}
    T15_10["15-10<br/>전체 fallback 복구 계획과 A 인계"]
    V15_10{"15-10 검증"}
  end
  T15_01 --> V15_01
  V15_01 -->|FAIL · 해당 태스크 보완| T15_01
  V15_01 -. BLOCKED .-> WAIT_A
  F15_01["작업 분기 · 격리 병렬 가능"]
  V15_01 -->|PASS| F15_01
  T15_02 --> V15_02
  V15_02 -->|FAIL · 해당 태스크 보완| T15_02
  V15_02 -. BLOCKED .-> WAIT_A
  F15_02["선행 PASS 공유<br/>15-06·15-10 합류 조건에 각각 전달"]
  V15_02 -->|PASS| F15_02
  T15_03 --> V15_03
  V15_03 -->|FAIL · 해당 태스크 보완| T15_03
  V15_03 -. BLOCKED .-> WAIT_A
  T15_04 --> V15_04
  V15_04 -->|FAIL · 해당 태스크 보완| T15_04
  V15_04 -. BLOCKED .-> WAIT_A
  F15_04["작업 분기 · 격리 병렬 가능"]
  V15_04 -->|PASS| F15_04
  T15_05 --> V15_05
  V15_05 -->|FAIL · 해당 태스크 보완| T15_05
  V15_05 -. BLOCKED .-> WAIT_A
  T15_06 --> V15_06
  V15_06 -->|FAIL · 해당 태스크 보완| T15_06
  V15_06 -. BLOCKED .-> WAIT_A
  J15_06{"합류 · 선행 4개 태스크 모두 PASS"}
  T15_07 --> V15_07
  V15_07 -->|FAIL · 해당 태스크 보완| T15_07
  V15_07 -. BLOCKED .-> WAIT_A
  T15_08 --> V15_08
  V15_08 -->|FAIL · 해당 태스크 보완| T15_08
  V15_08 -. BLOCKED .-> WAIT_A
  T15_09 --> V15_09
  V15_09 -->|FAIL · 해당 태스크 보완| T15_09
  V15_09 -. BLOCKED .-> WAIT_A
  T15_10 --> V15_10
  V15_10 -->|FAIL · 해당 태스크 보완| T15_10
  V15_10 -. BLOCKED .-> WAIT_A
  J15_10{"합류 · 선행 3개 태스크 모두 PASS"}
  ENTRY --> T15_01
  F15_01 --> T15_02
  F15_01 --> T15_03
  F15_01 --> T15_04
  F15_01 --> T15_05
  F15_02 --> J15_06
  V15_03 -->|PASS| J15_06
  F15_04 --> J15_06
  V15_05 -->|PASS| J15_06
  J15_06 -->|조건 충족| T15_06
  F15_04 --> T15_07
  V15_07 -->|PASS| T15_08
  V15_08 -->|PASS| T15_09
  F15_02 --> J15_10
  V15_06 -->|PASS| J15_10
  V15_09 -->|PASS| J15_10
  J15_10 -->|조건 충족| T15_10
  V15_10 -->|PASS| RV_A
  RV_A{"REVIEW A · 구간 전체 독립 검증"}
  RV_A -->|FAIL| REPAIR_A["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_A -. BLOCKED .-> WAIT_A
  WAIT_A["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_A -->|PASS| NEXT["REVIEW B 구간 진입"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_01,T15_02,T15_03,T15_04,T15_05,T15_06,T15_07,T15_08,T15_09,T15_10 task
  class V15_01,V15_02,V15_03,V15_04,V15_05,V15_06,V15_07,V15_08,V15_09,V15_10,RV_A verify
```

### REVIEW B · 7개 독립 태스크

```mermaid
flowchart TD
  ENTRY["REVIEW A PASS 후보"]
  subgraph G15_3["작업 구간 · 해상도·생성 정책"]
    T15_11["15-11<br/>행정·cell·이전 territory 공통 모델"]
    V15_11{"15-11 검증"}
    T15_12["15-12<br/>해상도·범위·비용 채점 기준 선고정"]
    V15_12{"15-12 검증"}
    T15_13["15-13<br/>결정적 분할 후보와 공통 경계 prototype"]
    V15_13{"15-13 검증"}
    T15_14["15-14<br/>대표 국가 해상도·연속 진격 실험"]
    V15_14{"15-14 검증"}
    T15_15["15-15<br/>stable ID와 provenance 결정성"]
    V15_15{"15-15 검증"}
    T15_16["15-16<br/>후보별 전체 비용 구조 비교"]
    V15_16{"15-16 검증"}
    T15_17["15-17<br/>생성 정책 선택과 B 인계"]
    V15_17{"15-17 검증"}
  end
  T15_11 --> V15_11
  V15_11 -->|FAIL · 해당 태스크 보완| T15_11
  V15_11 -. BLOCKED .-> WAIT_B
  T15_12 --> V15_12
  V15_12 -->|FAIL · 해당 태스크 보완| T15_12
  V15_12 -. BLOCKED .-> WAIT_B
  T15_13 --> V15_13
  V15_13 -->|FAIL · 해당 태스크 보완| T15_13
  V15_13 -. BLOCKED .-> WAIT_B
  F15_13["작업 분기 · 격리 병렬 가능"]
  V15_13 -->|PASS| F15_13
  T15_14 --> V15_14
  V15_14 -->|FAIL · 해당 태스크 보완| T15_14
  V15_14 -. BLOCKED .-> WAIT_B
  T15_15 --> V15_15
  V15_15 -->|FAIL · 해당 태스크 보완| T15_15
  V15_15 -. BLOCKED .-> WAIT_B
  T15_16 --> V15_16
  V15_16 -->|FAIL · 해당 태스크 보완| T15_16
  V15_16 -. BLOCKED .-> WAIT_B
  J15_16{"합류 · 선행 2개 태스크 모두 PASS"}
  T15_17 --> V15_17
  V15_17 -->|FAIL · 해당 태스크 보완| T15_17
  V15_17 -. BLOCKED .-> WAIT_B
  ENTRY --> T15_11
  V15_11 -->|PASS| T15_12
  V15_12 -->|PASS| T15_13
  F15_13 --> T15_14
  F15_13 --> T15_15
  V15_14 -->|PASS| J15_16
  V15_15 -->|PASS| J15_16
  J15_16 -->|조건 충족| T15_16
  V15_16 -->|PASS| T15_17
  V15_17 -->|PASS| RV_B
  RV_B{"REVIEW B · 구간 전체 독립 검증"}
  RV_B -->|FAIL| REPAIR_B["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_B -. BLOCKED .-> WAIT_B
  WAIT_B["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_B -->|PASS| NEXT["REVIEW C 구간 진입"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_11,T15_12,T15_13,T15_14,T15_15,T15_16,T15_17 task
  class V15_11,V15_12,V15_13,V15_14,V15_15,V15_16,V15_17,RV_B verify
```

### REVIEW C · 7개 독립 태스크

```mermaid
flowchart TD
  ENTRY["REVIEW B PASS 후보"]
  subgraph G15_4["작업 구간 · 전 세계 catalog"]
    T15_18["15-18<br/>전 국가 행정 복구와 protected overlay 입력"]
    V15_18{"15-18 검증"}
    T15_19["15-19<br/>전 세계 operational cell 생성"]
    V15_19{"15-19 검증"}
    T15_20["15-20<br/>topology·membership·이전 부모 index"]
    V15_20{"15-20 검증"}
    T15_21["15-21<br/>LOD·render asset·delivery index 생성"]
    V15_21{"15-21 검증"}
    T15_22["15-22<br/>전 국가 보존·geometry·topology 감사"]
    V15_22{"15-22 검증"}
    T15_23["15-23<br/>두 번째 독립 전 세계 생성"]
    V15_23{"15-23 검증"}
    T15_24["15-24<br/>C 후보 계약과 전달 묶음 고정"]
    V15_24{"15-24 검증"}
  end
  T15_18 --> V15_18
  V15_18 -->|FAIL · 해당 태스크 보완| T15_18
  V15_18 -. BLOCKED .-> WAIT_C
  T15_19 --> V15_19
  V15_19 -->|FAIL · 해당 태스크 보완| T15_19
  V15_19 -. BLOCKED .-> WAIT_C
  T15_20 --> V15_20
  V15_20 -->|FAIL · 해당 태스크 보완| T15_20
  V15_20 -. BLOCKED .-> WAIT_C
  T15_21 --> V15_21
  V15_21 -->|FAIL · 해당 태스크 보완| T15_21
  V15_21 -. BLOCKED .-> WAIT_C
  T15_22 --> V15_22
  V15_22 -->|FAIL · 해당 태스크 보완| T15_22
  V15_22 -. BLOCKED .-> WAIT_C
  T15_23 --> V15_23
  V15_23 -->|FAIL · 해당 태스크 보완| T15_23
  V15_23 -. BLOCKED .-> WAIT_C
  T15_24 --> V15_24
  V15_24 -->|FAIL · 해당 태스크 보완| T15_24
  V15_24 -. BLOCKED .-> WAIT_C
  ENTRY --> T15_18
  V15_18 -->|PASS| T15_19
  V15_19 -->|PASS| T15_20
  V15_20 -->|PASS| T15_21
  V15_21 -->|PASS| T15_22
  V15_22 -->|PASS| T15_23
  V15_23 -->|PASS| T15_24
  V15_24 -->|PASS| RV_C
  RV_C{"REVIEW C · 구간 전체 독립 검증"}
  RV_C -->|FAIL| REPAIR_C["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_C -. BLOCKED .-> WAIT_C
  WAIT_C["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_C -->|PASS| NEXT["REVIEW D 구간 진입"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_18,T15_19,T15_20,T15_21,T15_22,T15_23,T15_24 task
  class V15_18,V15_19,V15_20,V15_21,V15_22,V15_23,V15_24,RV_C verify
```

### REVIEW D · 11개 독립 태스크

```mermaid
flowchart TD
  ENTRY["REVIEW C PASS 후보"]
  F_ENTRY_D["작업 분기 · 격리 병렬"]
  ENTRY --> CONTRACT_D["공통 catalog·revision·authority·cap 계약<br/>파일 소유 범위 고정"]
  CONTRACT_D --> F_ENTRY_D
  subgraph G15_5["작업 구간 · 지역·전선 도구"]
    T15_25["15-25<br/>지역 directory·큰 membership resolver"]
    V15_25{"15-25 검증"}
    T15_26["15-26<br/>strict lookup/submit 공유 schema"]
    V15_26{"15-26 검증"}
    T15_27["15-27<br/>현재 전선 기반 bounded graph 선택"]
    V15_27{"15-27 검증"}
    T15_28["15-28<br/>host 제출 범위·선택 증명 검증"]
    V15_28{"15-28 검증"}
    T15_29["15-29<br/>provider lookup→submit·repair 연결"]
    V15_29{"15-29 검증"}
    T15_30["15-30<br/>near 실측 cap과 도구 분기 인계"]
    V15_30{"15-30 검증"}
  end
  subgraph G15_6["작업 구간 · 상태·참조 migration"]
    T15_31["15-31<br/>이전 territory→새 cell mapping 검증"]
    V15_31{"15-31 검증"}
    T15_32["15-32<br/>owner/controller·authority 상태 이전"]
    V15_32{"15-32 검증"}
    T15_33["15-33<br/>simulation·pending·history 참조 정책"]
    V15_33{"15-33 검증"}
    T15_34["15-34<br/>atomic version 전환과 undo/redo"]
    V15_34{"15-34 검증"}
    T15_35["15-35<br/>migration 호환성·실패 분기 인계"]
    V15_35{"15-35 검증"}
  end
  T15_25 --> V15_25
  V15_25 -->|FAIL · 해당 태스크 보완| T15_25
  V15_25 -. BLOCKED .-> WAIT_D
  T15_26 --> V15_26
  V15_26 -->|FAIL · 해당 태스크 보완| T15_26
  V15_26 -. BLOCKED .-> WAIT_D
  T15_27 --> V15_27
  V15_27 -->|FAIL · 해당 태스크 보완| T15_27
  V15_27 -. BLOCKED .-> WAIT_D
  T15_28 --> V15_28
  V15_28 -->|FAIL · 해당 태스크 보완| T15_28
  V15_28 -. BLOCKED .-> WAIT_D
  T15_29 --> V15_29
  V15_29 -->|FAIL · 해당 태스크 보완| T15_29
  V15_29 -. BLOCKED .-> WAIT_D
  T15_30 --> V15_30
  V15_30 -->|FAIL · 해당 태스크 보완| T15_30
  V15_30 -. BLOCKED .-> WAIT_D
  T15_31 --> V15_31
  V15_31 -->|FAIL · 해당 태스크 보완| T15_31
  V15_31 -. BLOCKED .-> WAIT_D
  T15_32 --> V15_32
  V15_32 -->|FAIL · 해당 태스크 보완| T15_32
  V15_32 -. BLOCKED .-> WAIT_D
  T15_33 --> V15_33
  V15_33 -->|FAIL · 해당 태스크 보완| T15_33
  V15_33 -. BLOCKED .-> WAIT_D
  T15_34 --> V15_34
  V15_34 -->|FAIL · 해당 태스크 보완| T15_34
  V15_34 -. BLOCKED .-> WAIT_D
  T15_35 --> V15_35
  V15_35 -->|FAIL · 해당 태스크 보완| T15_35
  V15_35 -. BLOCKED .-> WAIT_D
  F_ENTRY_D --> T15_25
  V15_25 -->|PASS| T15_26
  V15_26 -->|PASS| T15_27
  V15_27 -->|PASS| T15_28
  V15_28 -->|PASS| T15_29
  V15_29 -->|PASS| T15_30
  F_ENTRY_D --> T15_31
  V15_31 -->|PASS| T15_32
  V15_32 -->|PASS| T15_33
  V15_33 -->|PASS| T15_34
  V15_34 -->|PASS| T15_35
  J_D{"합류 · 두 분기 마지막 태스크 모두 PASS"}
  V15_30 -->|PASS| J_D
  V15_35 -->|PASS| J_D
  J_D --> MERGE_D["새 통합 작업본 구성"]
  MERGE_D --> RV_D
  RV_D{"REVIEW D · 구간 전체 독립 검증"}
  RV_D -->|FAIL| REPAIR_D["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_D -. BLOCKED .-> WAIT_D
  WAIT_D["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_D -->|PASS| NEXT["REVIEW E 구간 진입"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_25,T15_26,T15_27,T15_28,T15_29,T15_30,T15_31,T15_32,T15_33,T15_34,T15_35 task
  class V15_25,V15_26,V15_27,V15_28,V15_29,V15_30,V15_31,V15_32,V15_33,V15_34,V15_35,RV_D verify
```

### REVIEW E · 7개 독립 태스크

```mermaid
flowchart TD
  ENTRY["REVIEW D PASS 후보"]
  subgraph G15_7["작업 구간 · runtime·지도·행동"]
    T15_36["15-36<br/>effect→authoritative state runtime 연결"]
    V15_36{"15-36 검증"}
    T15_37["15-37<br/>incremental projection·점령색·전선 연결"]
    V15_37{"15-37 검증"}
    T15_38["15-38<br/>경계 layer·zoom·국가 UI 회귀"]
    V15_38{"15-38 검증"}
    T15_39["15-39<br/>한국/북한 도 내부 일부 점령 E2E"]
    V15_39{"15-39 검증"}
    T15_40["15-40<br/>후속 진격·해방·양도·undo/redo E2E"]
    V15_40{"15-40 검증"}
    T15_41["15-41<br/>슬로베니아 실제 경계·조회·작은 점령 E2E"]
    V15_41{"15-41 검증"}
    T15_42["15-42<br/>타 대륙 일반화·실패 동작과 E 인계"]
    V15_42{"15-42 검증"}
  end
  T15_36 --> V15_36
  V15_36 -->|FAIL · 해당 태스크 보완| T15_36
  V15_36 -. BLOCKED .-> WAIT_E
  T15_37 --> V15_37
  V15_37 -->|FAIL · 해당 태스크 보완| T15_37
  V15_37 -. BLOCKED .-> WAIT_E
  T15_38 --> V15_38
  V15_38 -->|FAIL · 해당 태스크 보완| T15_38
  V15_38 -. BLOCKED .-> WAIT_E
  F15_38["작업 분기 · 격리 병렬 가능"]
  V15_38 -->|PASS| F15_38
  T15_39 --> V15_39
  V15_39 -->|FAIL · 해당 태스크 보완| T15_39
  V15_39 -. BLOCKED .-> WAIT_E
  T15_40 --> V15_40
  V15_40 -->|FAIL · 해당 태스크 보완| T15_40
  V15_40 -. BLOCKED .-> WAIT_E
  T15_41 --> V15_41
  V15_41 -->|FAIL · 해당 태스크 보완| T15_41
  V15_41 -. BLOCKED .-> WAIT_E
  T15_42 --> V15_42
  V15_42 -->|FAIL · 해당 태스크 보완| T15_42
  V15_42 -. BLOCKED .-> WAIT_E
  J15_42{"합류 · 선행 2개 태스크 모두 PASS"}
  ENTRY --> T15_36
  V15_36 -->|PASS| T15_37
  V15_37 -->|PASS| T15_38
  F15_38 --> T15_39
  V15_39 -->|PASS| T15_40
  F15_38 --> T15_41
  V15_40 -->|PASS| J15_42
  V15_41 -->|PASS| J15_42
  J15_42 -->|조건 충족| T15_42
  V15_42 -->|PASS| RV_E
  RV_E{"REVIEW E · 구간 전체 독립 검증"}
  RV_E -->|FAIL| REPAIR_E["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_E -. BLOCKED .-> WAIT_E
  WAIT_E["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_E -->|PASS| NEXT["REVIEW F 구간 진입"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_36,T15_37,T15_38,T15_39,T15_40,T15_41,T15_42 task
  class V15_36,V15_37,V15_38,V15_39,V15_40,V15_41,V15_42,RV_E verify
```

### REVIEW F · 6개 독립 태스크

```mermaid
flowchart TD
  ENTRY["REVIEW E PASS 후보"]
  subgraph G15_8["작업 구간 · 최종 후보 검증"]
    T15_43["15-43<br/>최종 후보와 검증 입력 동결"]
    V15_43{"15-43 검증"}
    T15_44["15-44<br/>최종 전 세계 감사와 생성 단계 음성 검증"]
    V15_44{"15-44 검증"}
    T15_45["15-45<br/>실제 API 성공·실패와 예산 검증"]
    V15_45{"15-45 검증"}
    T15_46["15-46<br/>최종 브라우저·턴 음성·기존 회귀"]
    V15_46{"15-46 검증"}
    T15_47["15-47<br/>전 세계·서버·브라우저·provider 실측 성능"]
    V15_47{"15-47 검증"}
    T15_48["15-48<br/>후보 delivery·복구 준비와 F 인계"]
    V15_48{"15-48 검증"}
  end
  T15_43 --> V15_43
  V15_43 -->|FAIL · 해당 태스크 보완| T15_43
  V15_43 -. BLOCKED .-> WAIT_F
  F15_43["작업 분기 · 격리 병렬 가능"]
  V15_43 -->|PASS| F15_43
  T15_44 --> V15_44
  V15_44 -->|FAIL · 해당 태스크 보완| T15_44
  V15_44 -. BLOCKED .-> WAIT_F
  T15_45 --> V15_45
  V15_45 -->|FAIL · 해당 태스크 보완| T15_45
  V15_45 -. BLOCKED .-> WAIT_F
  T15_46 --> V15_46
  V15_46 -->|FAIL · 해당 태스크 보완| T15_46
  V15_46 -. BLOCKED .-> WAIT_F
  T15_47 --> V15_47
  V15_47 -->|FAIL · 해당 태스크 보완| T15_47
  V15_47 -. BLOCKED .-> WAIT_F
  J15_47{"합류 · 선행 3개 태스크 모두 PASS"}
  T15_48 --> V15_48
  V15_48 -->|FAIL · 해당 태스크 보완| T15_48
  V15_48 -. BLOCKED .-> WAIT_F
  ENTRY --> T15_43
  F15_43 --> T15_44
  F15_43 --> T15_45
  F15_43 --> T15_46
  V15_44 -->|PASS| J15_47
  V15_45 -->|PASS| J15_47
  V15_46 -->|PASS| J15_47
  J15_47 -->|조건 충족| T15_47
  V15_47 -->|PASS| T15_48
  V15_48 -->|PASS| RV_F
  RV_F{"REVIEW F · 구간 전체 독립 검증"}
  RV_F -->|FAIL| REPAIR_F["총괄이 원인 태스크 선택<br/>변경 영향 증거 무효화·해당 태스크 재배정"]
  RV_F -. BLOCKED .-> WAIT_F
  WAIT_F["환경·권한·입력 대기<br/>해당 태스크와 의존 작업 해제 금지"]
  RV_F -->|PASS| DONE["후보 보존·사용자 지시 대기"]
  classDef task fill:#eff6ff,stroke:#2563eb,color:#111827
  classDef verify fill:#fef3c7,stroke:#d97706,color:#111827
  class T15_43,T15_44,T15_45,T15_46,T15_47,T15_48 task
  class V15_43,V15_44,V15_45,V15_46,V15_47,V15_48,RV_F verify
```

## 태스크 검증·보완·재개

```mermaid
flowchart TD
  S["총괄: PASS·stale·blocked와 의존성 조회"] --> READY{"선행 태스크·이전 REVIEW 모두 PASS?"}
  READY -->|아니오| WAIT_DEP["의존 조건 대기"]
  READY -->|예| RES{"쓰기 경로·게임 상태 격리와 자원 여유?"}
  RES -->|없음| QUEUE["실행 대기열"]
  RES -->|있음| RUN["독립 태스크 배정·실행"]
  RUN --> RETURN["산출물·입력 manifest·실행 결과를 총괄에게 반환"]
  RETURN --> BIND{"원본 배정·실제 후보·입력 identity 일치?"}
  BIND -->|아니오| HANDOFF["전달 장애 대기·검증 배정 금지"]
  BIND -->|예| VERIFY["독립 검증자: 해당 태스크 범위만 도구로 검사"]
  VERIFY --> RESULT{"태스크 검증 결과"}
  RESULT -->|FAIL| FIX["총괄: 같은 태스크 보완 배정<br/>영향받은 후속 PASS를 stale 처리"]
  FIX --> CHANGED{"실제 보완 입력 변경?"}
  CHANGED -->|아니오| SAME["동일 실패 재검증 차단·원인 재검토"]
  CHANGED -->|예| RUN
  RESULT -->|BLOCKED| BLOCK["환경·권한·외부 입력 대기<br/>태스크와 의존 작업은 미통과 유지"]
  RESULT -->|PASS| PIN{"검증 후 입력 bytes 유지?"}
  PIN -->|아니오| STALE["stale 처리·원인과 변경 영향 재배정"]
  STALE --> S
  PIN -->|예| SAVE["태스크 PASS·후보/증거 identity 저장"]
  SAVE --> RELEASE["의존 작업 재계산<br/>준비된 태스크를 격리 병렬 배정"]
  RELEASE --> ALL{"구간의 모든 태스크 PASS?"}
  ALL -->|아니오| S
  ALL -->|예| REVIEW{"REVIEW 전체 독립 검증"}
  REVIEW -->|PASS| ADV["다음 구간 해제·F이면 대기"]
  REVIEW -->|FAIL| CAUSE["총괄: 원인 태스크·변경 영향만 무효화·재배정"]
  CAUSE --> S
  REVIEW -->|BLOCKED| BLOCK
```

## 세 경로와 후보 승인

| 항목 | 역할 |
| --- | --- |
| controlRoot/projectRoot | 운영 코드·정책·run·보고서 저장소. 제품 검사 대상으로 대체 금지 |
| productRoot/candidateRoot | 실제 구현·import·빌드·검증의 제품 경로 |
| reportDirectory | 이번 독립 검증의 새 증거 위치 |

컨트롤러는 배정한 실제 작업본의 source/config/e2e/validation 목록과 추가 제품 입력을 고정한다. target.json은 원본 배정 identity, 확정된 구현 turn/response identity, product-inputs manifest, revision, targetId를 연결한다. completed/blocked 모두 같은 전달 계약을 사용한다. 모델의 자유로운 경로 보고나 요약만으로 후보를 선택하지 않는다. 누락·변조·경로 불일치는 handoff 장애로 중단하며 원본으로 fallback하지 않는다.

승인 후보는 불변이다. 새 REVIEW는 소스만 복사하고 data/public/node_modules 및 승인 reports/prompt14는 읽기 전용 공유한다. 변조 fixture는 명시한 소수 파일만 복사한다. 리뷰로 되돌아가면 승인본을 fork하고 후속 작업본 포인터를 폐기하되 실제 파일과 이력은 보존한다. 15-5/15-6은 서로 겹치지 않는 소유 경로에서 구현하며 병합 대상은 D의 새 통합 작업본이다.

독립 PASS에는 실제 candidateRoot/targetId와 manifest attestation이 필요하다. stage journal은 후보 source를 자동 pin하고 controlRoot의 src·제품 scripts·package/config를 검사 입력으로 선택하면 거부한다. PASS certificate도 그 후보를 참조한다. 다음 리뷰는 이 승인 후보에서 시작한다. B24개국·C 원문 독립 생성·E/F 실제 브라우저 등 원문 필수 범위는 유지한다.

## 실패 집계와 복구

관측된 검증 결과 수와 고유 구현 실패 수를 구별한다. 실패 키는 REVIEW + 실제 후보 revision + 실패 gate다. 폴더·jobId·보고서 이름이 달라져도 같은 입력의 실패는 한 번 집계한다. 수정했다고 보고했지만 실패 revision이 그대로면 새 검증 모델을 호출하지 않고 handoff 장애로 대기한다. 환경·전달·외부 권한 차단은 구현 스트라이크가 아니다.

확정된 구현/검증 turn은 원본 요청·schema·cwd·완료 응답과 연결하여 저장한다. 완료 보고 저장 후 중단되면 그 보고를 전달하고, 검증 응답 저장 후 중단되면 고정 입력과 journal을 다시 대조해 판정을 게시한다. 이미 확인된 turn을 다시 실행하지 않는다. 완료 응답이 없는 불확실한 작업은 완료로 추정하지 않는다. 런타임 복구는 최대 다섯 번 뒤 운영 대기로 전환하며 사용자 중단·수동 모드는 자동 해제하지 않는다.

3스트라이크는 서로 다른 실제 구현 실패에 적용한다. 총괄은 다른 접근과 구체적 보완 계획을 작성하고 기록한다. 작은 태스크 PASS·실행 도구 장애·단순 재시도는 REVIEW 실패 누적을 초기화하지 않는다. 과거 네 번의 baseline 판정은 삭제하지 않고 별도 감사 기록으로 중복 관측 관계를 설명한다.

## 14 수동 결과 접수

접수 도구는 모델·네트워크를 호출하지 않는다. 수동 독립 결과는 review=prompt14, verdict=pass와 필수 다섯 gate(typecheck, production_build, handler_contracts, catalog_identity, browser_regressions), 실제 commands/exitCode, evidence identity, inputs identity를 갖춘 기계 판정 파일이어야 한다. 기존 수동 보고 형식이 다르면 원본 보고를 보존하고 그 증거를 참조하는 명시적 판정 파일로 정리한다. PASS 문자열이나 구현자의 자체 보고만으로 접수하지 않는다.

공통 입력을 별도 파일에 보관했다면 verdict.inputs에 그 파일 identity를 넣고 verdict.inputManifests에도 같은 identity를 기록한다. 각 공통 파일은 version=1, inputs=[{path,sha256,byteLength}] 형식이다. 실제 후보의 모든 고정 source 입력과 현재 공유 입력을 대조하며 누락·변조·미실행이 있으면 접수하지 않는다.

```text
node scripts/prompt15-orchestrator/adopt-manual-baseline.mjs <독립판정.json> <실제후보> <새접수보고폴더>
```

명령은 baseline-receipt.json만 작성하며 executionMode를 변경하지 않는다. 수동 PASS와 사용자 재개 지시가 확인된 뒤 운영 담당자가 manualBaselineReceipt를 연결하고 executionMode=orchestrated로 전환한다. 이 문서 수정 작업에서는 접수·실행하지 않는다.

## 운영 코드와 제품 검증의 분리

총괄·구현·검증은 각각 독립 root thread를 유지하며 대화 이력을 복사/fork하지 않는다. 모든 전달은 총괄을 거친다. 제품 역할은 운영 코드·다른 세션을 수정하지 않는다. 전달 문제는 운영 담당자가 별도로 보완하며 제품 재구현을 반복 배정하지 않는다.

제어 도구 자체는 node:test의 소형 실제 filesystem fixture로 검증한다. 제품은 Vitest/fast-check, 실제 CLI, Playwright를 사용한다. 제어 self-test PASS를 제품 REVIEW 승인으로 취급하지 않는다. 입력 manifest는 한 번 저장하고 참조하며 명령 로그는 스트림당 256 KiB 이하로 보관한다. 사고·heartbeat는 실행 완료 증거가 아니다. 검증 turn에서 실제 도구 실행 없이 15분이 지나면 자기 turn만 interrupt하고 환경 timeout으로 기록한다. 실행 중인 실제 명령은 idle로 오인하지 않는다.

v12 제품 테스트 러너는 `run-target-checks.mjs <job-context.json> <이번 job 안의 새 결과폴더> <명시한 파일...> [--environment node|jsdom]`다. 실제 후보의 @ alias와 UI setup을 사용하고 독립 테스트는 검증 보고서 안에서 작성한다. stage의 실제 cwd는 productRoot이며 command argv의 파일·증거 경로는 절대 경로로 지정한다. 원본 저장소의 package/source를 테스트 대상으로 선택하지 않는다. 빌드용 복사본은 검증 폴더 안에 두고 후보와 source/config bytes의 대응을 검사한다. 이 러너의 PASS는 명시한 테스트 범위에만 유효하다.

주요 구현: product-target.mjs(후보/배정 계약), launch-policy.mjs(수동 gate/접수), workflow.mjs(단계/후보 전달/복구), verification-stages-compact.mjs(고정 후보 journal), policy.mjs(집계/오류 분류), workspaces.mjs(격리/소유/병합). 레거시 v9/v10 journal은 기존 이력 호환용으로 유지한다.
