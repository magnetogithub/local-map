# 다른 Windows PC로 Prompt15 이전

이전 태그는 `prompt15-transfer-20261019-cdrive`다. 해당 태그의 **공개 Release가
존재하고 `validation-report.json`이 통과한 경우에만** 아래 절차를 사용한다.
발행기는 원본 입력 검사, 독립 복원 검사와 운영 회귀검사가 통과하지 않으면
Release를 공개하지 않는다. 소스 코드를 pull하는 것만으로 실행 기록은 복원되지 않는다.

이전 자료는 공개 GitHub Release의 별도 첨부파일이다. 과거 로그 전체를 Git
이력에 다시 추가하지 않는다. 원본 승인·실패·구현 증거는 파일 바이트 그대로
보존한다. REVIEW A 승인과 15-13 BLOCKED 상태를 유지하며 B 승인을 만들지 않는다.

## 새 PC 준비

- Windows x64에서 프로젝트 경로는 기본값 `C:\gen`을 사용한다. D: 드라이브는 필요 없다. 기존 프로젝트 폴더가
  있으면 설치기는 덮어쓰지 않는다.
- Git for Windows와 Node.js **24.18.0 x64**를 설치한다. Node 경로는
  `C:\Program Files\nodejs\node.exe`이며 원본 실행파일의 SHA256도 검사한다.
- Codex를 설치하고 새 PC에서 로그인한다. 역할 모델은 기존 설정의
  `gpt-6.1-sol`, effort `high`를 유지한다. 해당 모델을 사용할 수 있어야 한다.
- Release에서 첨부파일 전체를 다운로드할 수 있어야 한다. 설치기는 소스만
  체크아웃하고 필요한 입력은 이전 패키지에서 복원한다.

## 실행

프로젝트를 아직 받지 않은 새 PC에서는 다음을 실행한다. 기존 프로젝트와
원래 PC의 실행 기록을 덮어쓰지 않는다.

```powershell
$tag = 'prompt15-transfer-20261019-cdrive'
$script = Join-Path $env:TEMP 'install-prompt15-transfer.ps1'
Invoke-WebRequest "https://raw.githubusercontent.com/magnetogithub/local-map/$tag/tools/install-prompt15-transfer.ps1" -OutFile $script
powershell -ExecutionPolicy Bypass -File $script -Tag $tag -Destination C:\gen
```

이미 다른 PC의 `C:\gen`에서 최신 main을 pull했고, 이 PC에 이전 실행 기록이
없다면 다음으로 필요한 Release 입력을 내려받고 복원한다.

```powershell
Set-Location C:\gen
powershell -ExecutionPolicy Bypass -File tools/install-prompt15-transfer.ps1 -Tag prompt15-transfer-20261019-cdrive -Destination C:\gen -ExistingCheckout
```

기존 체크아웃은 Release의 소스 커밋과 일치해야 하며 소스 변경이 없어야 한다.
원래 PC에는 기존 실행 기록이 있으므로 이 설치 명령을 실행하지 않는다.

설치기는 내려받은 파일과 모든 복원 파일의 SHA256을 검사하고, `npm ci`를
수행한다. 원본 Prompt14 승인과 A/B 후보 바인딩을 검사한 뒤 기존 운영 회귀
검사를 실제 실행한다. 하나라도 실패하면 재개하지 않는다.

성공하면 실행기는 **중단 상태**다. 새 PC에서 Codex 로그인 뒤 다음을 실행한다.

```powershell
Set-Location C:\gen
node scripts/prompt15-orchestrator/run.mjs check
node tools/prompt15-runtime.mjs resume --run reports/prompt15/orchestration/20261015T115644-KST-eae9ad74
```

설치 시 `-Resume`을 지정하면 검증과 로그인 확인이 모두 성공했을 때 위 재개
명령을 실행한다. 사용자 명령 없이 설치 과정 자체가 모델 작업을 시작하지 않는다.

## 보존 범위와 세션 인계

- 원본 state는 `transfer/source-state.json`, 이전 접수는 `transfer/receipt.json`
  에 별도로 보존한다. 승인, 태스크 행, 구현 실패 횟수는 바꾸지 않는다.
- 이전 PC의 PID, native 세션 소유권, 운영 감사 대기열은 과거 상태로 보관한다.
  새 PC의 실행 세션은 새로 만들고 기존 요청·응답·계약·후보 기록을 사용한다.
- `.codex`, 인증 토큰, 개인 환경 파일, Discord webhook은 옮기지 않는다.
  현재 PC의 로그인 상태가 새 PC로 복사됐다고 가정하지 않는다.
- 인증된 기존 증거가 참조하는 일부 과거 검사 파일은 포함된다. 실행기 검증에
  필요한 증거와 단순 진행 로그를 구분한다.
- 원본 영수증의 `D:\gen` 경로와 해시를 그대로 보존한다. 로컬
  `.tmp/prompt15-location.json`에 기록된 목적지로 파일 접근과 경로 비교만 연결한다.
  자식 Node 프로세스도 같은 연결을 사용하며 모델의 cwd와 쓰기 범위는 새 경로다.
  다른 목적지는 설치 시 `-Destination`으로 지정한다. 가상 디스크나 D: 별칭은 만들지 않는다.
- 사용자 계정 전체의 Codex 대화를 복제하지 않는다. 모델 추론은 확률적이므로
  새 세션의 후속 판단과 표현이 이전 세션과 똑같다고 보장하지 않는다.

검증은 압축파일에서 별도 시험 폴더에 실제 바이트를 복원한 다음 수행한다.
`tools/prompt15-location.mjs`는 영수증에 적힌 원래 절대 경로를 복원
폴더로만 연결하며, 누락 파일을 원래 작업공간에서 대신 읽지 않는다. 복원 폴더의
의존성은 새로 설치하고, 원래 승인 연결과 운영 회귀검사를 실제로 다시 확인한다.
정확한 결과와 패키지 해시는 Release의 `validation-report.json`에 남긴다.
계정 로그인과 실제 새 PC에서의 모델 작업 시작은 그 PC에서 수행해야 한다.

공식 app-server의 세션 생성·턴 실행 절차:
https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
