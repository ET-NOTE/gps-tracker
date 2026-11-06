# 인프라 1차 2단계 — PDF 처리기의 별도 계정·서비스 분리

2026-11-06 · GPS 운영 서버(`gps.serial.kr`) · `codex/location-business-prep` · [1단계: 실행 계정 분리](infra-round1-runtime-account-20261106.md)

> **상태: 운영 적용 완료.** 새 API 릴리스 `pdf-service-20261106-r1`(2026-11-06 16:44 KST, 에이전트 실행), 처리기 서비스(16:48 KST, 운영자 실행), 서비스 방식 기능 확인 통과(16:49 KST). 운영의 PDF 처리기는 이제 API와 다른 계정 `gps-pdf`로, 네트워크 없이, 자기 실행 파일만 보이는 환경에서 요청마다 한 번 실행된다.

## 배경

1단계로 API는 sudo·docker 권한이 없는 `gps-api` 계정이 됐다. 그러나 PDF 처리기는 여전히 **API가 자식 프로세스로 실행**한다. 그래서 처리기는 API와 같은 계정으로 돌고, API가 읽을 수 있는 것(환경파일, FCM 키, 업로드 파일)을 볼 수 있는 자리에 있다. 처리기 자신이 파일·소켓·프로그램 실행을 스스로 차단하지만, 그 차단이 유일한 방어선이다.

2단계는 처리기를 API와 다른 계정의 별도 실행 환경으로 옮긴다. 처리기 자신의 차단이 뚫려도 볼 수 있는 것이 자기 실행 파일뿐이게 한다.

**방화벽 변경, 디스크 정리, 회사 데이터 파기 정책은 이 작업과 섞지 않는 별도 항목이다.**

## 구성

```
API (gps-api)  ──요청──▶  /run/gps-pdf-render/render.sock  (root:gps-api 660)
                                   │  접속 1건마다 systemd가 처리기 1개 시작
                                   ▼
                          gps-pdf-render@….service  (gps-pdf)
                          실행 파일만 보이는 빈 읽기 전용 루트 · 네트워크 없음
```

- **계정** `gps-pdf`: 시스템 계정, 로그인 셸 없음, 홈 없음, 소속 그룹 없음(sudo·docker·`gps-api` 아님).
- **유닛 3개와 API drop-in 1개**

  | 파일 | 역할 |
  |---|---|
  | `gps-pdf-render-selftest.service` | 처리기 자체 점검을 **서비스와 같은 환경에서** 한 번 실행하고 결과를 유지한다 |
  | `gps-pdf-render.socket` | 자체 점검이 통과한 뒤에만 생기는 소켓. `root:gps-api 660`이라 API 계정만 접속할 수 있다. 접속마다 처리기 하나(`Accept=yes`), 동시 4건까지 |
  | `gps-pdf-render@.service` | 쪽 하나를 그리고 끝나는 처리기. 요청과 응답은 접속 그 자체(표준 입출력) |
  | `gps-tracker-api.service.d/20-pdf-socket.conf` | API에 `GPS_PDF_SOCKET`을 주고 소켓을 `Wants=`로 끌어온다 |

- **처리기 실행 환경**(자체 점검과 쪽 처리에 같은 설정)

  | 설정 | 효과 |
  |---|---|
  | `User`/`Group=gps-pdf`, `SupplementaryGroups=` | API와 다른 계정 |
  | `TemporaryFileSystem=/:ro` + `BindReadOnlyPaths=`처리기 파일 | 빈 읽기 전용 루트에 처리기 파일 하나만 보인다. 홈·업로드·환경파일·`/etc`가 없다 |
  | `PrivateNetwork=yes`, `IPAddressDeny=any`, `RestrictAddressFamilies=none` | 네트워크 없음(루프백 장치만 있는 전용 네임스페이스), 소켓 생성 불가 |
  | `PrivateDevices=yes`, `ProtectProc=invisible`, `ProcSubset=pid` | 장치 없음, 다른 프로세스가 보이지 않음 |
  | `NoNewPrivileges=yes`, 능력 전부 제거, `RestrictNamespaces`·`RestrictSUIDSGID`·`LockPersonality`·`MemoryDenyWriteExecute` 등 | 권한을 얻을 길 없음 |
  | `SystemCallFilter=@system-service seccomp`, `SystemCallArchitectures=native` | 시스템 호출 허용 목록(아래 "실험에서 확인한 것") |
  | `MemoryMax=832M`, `MemorySwapMax=0`, `TasksMax=16`, `LimitCORE=0` | cgroup 메모리 한도(스왑 없음). 처리기 자신의 한도 768MiB보다 조금 위라 처리기의 한도가 먼저 걸린다 |
  | `RuntimeMaxSec=20` (쪽 처리) | 실행 시간 한도. API의 대기 한도 15초보다 길다 |

- **처리기 자신의 제한은 그대로다**: 입력을 읽기 전에 스스로 거는 시스템 호출 차단(파일·소켓·프로그램 실행·프로세스 생성), 메모리 768MiB, CPU 10초, 200쪽. 서비스 환경은 그 바깥에 한 겹을 더한다.
- **쓰지 않을 때 드는 자원은 없다.** 상주 프로세스가 없고, 요청이 올 때만 처리기가 뜬다(리허설에서 쪽당 수십 ms).

## API 변경 (릴리스 `pdf-service-20261106-r1`)

- `GPS_PDF_SOCKET`이 있으면 쪽 요청을 그 소켓으로 보낸다. 요청·응답 형식, 15초 대기 한도, 한 번에 한 쪽 제한은 같다. 소켓에 접속할 수 없으면 **PDF 쪽만** "사용할 수 없음"으로 답하고 다른 기능은 영향이 없다.
- `GPS_PDF_SOCKET`이 없으면 **이전과 완전히 같은 동작**이다(처리기를 직접 실행, 첫 사용 전 자체 점검).
- 바뀌는 것은 API 바이너리 하나다. **스키마(98), 웹, 처리기 파일은 바뀌지 않는다.** 스테이징이 처리기·웹·마이그레이션 소스 417개 파일을 16차 소스 묶음과 대조해 같음을 확인하고, 처리기는 운영이 실행 중인 그 파일(`3eaaf553…`)을 그대로 쓴다. 그래서 API 되돌림은 언제든 이전 바이너리로 가능하다.

## 동작 특성

- **재부팅**: 소켓은 부팅 때 스스로 올라온다(자체 점검 약 5초 뒤). API는 소켓을 기다리지 않으므로 수집·인증 등은 바로 동작하고, PDF 쪽만 그 몇 초 동안 "사용할 수 없음"이다.
- **자체 점검이 실패하면**(예: 커널 변경으로 처리기 차단이 성립하지 않을 때) 소켓이 생기지 않는다. PDF 쪽은 "사용할 수 없음"으로 답하고 나머지는 정상이다. API가 처리기를 직접 실행하는 방식으로 자동 전환되지는 않는다(증명되지 않은 환경에서 원본을 처리하지 않기 위해서다). 상태는 `systemctl status gps-pdf-render.socket gps-pdf-render-selftest.service`로 본다.
- API가 재시작될 때마다 소켓이 내려가 있으면 다시 시도한다(`Wants=`).

## 실험에서 확인한 것 (systemd 249)

리허설 호스트에서 옵션별로 시험해 정했다.

- 이 systemd의 `@system-service` 묶음에는 `seccomp` 호출이 없다. 처리기는 자기 차단을 걸 때 이 호출을 쓰므로 묶음만 쓰면 처리기가 그 자리에서 종료된다. 그래서 `seccomp`을 명시해 허용했다. 리허설의 강제 실패 하나가 바로 이 경우다.
- `DynamicUser=yes`는 `TemporaryFileSystem=/:ro`와 같이 쓰면 호스트 파일이 그대로 보였다. 그래서 고정 계정(`gps-pdf`)과 빈 루트 + 처리기 파일 바인드를 쓴다.
- 소켓 유닛을 기본 의존성으로 두면 "부팅 초기 소켓 단계보다 앞"이면서 "일반 서비스인 자체 점검보다 뒤"가 되어 부팅 때 순서가 맞물린다. 소켓의 기본 의존성을 끄고 일반 단계에서 올라오게 했다. 리허설의 재부팅 시험이 이를 확인한다(순서 충돌 0건).
- API가 소켓을 `After=`로 기다리면 API 기동이 자체 점검 시간(약 5초)만큼 늦어지고, 점검이 실패하는 동안 재시작마다 늦어진다. 그래서 `Wants=`만 둔다.

## 절차

| 스크립트 | 실행 위치 | 하는 일 |
|---|---|---|
| `ops/stage_pdf_service.py` | 빌드 호스트 | 빌드 → 시험 → 패키징 → systemd 리허설. 운영에 접근하지 않는다 |
| `ops/release_pdf_service.py` | 운영 서버(root) | API 바이너리의 `check`(읽기 전용) · `apply` · `rollback` |
| `ops/pdf_service.py` | 운영 서버(root) | 처리기 서비스의 `check`(읽기 전용) · `apply` · `rollback` |
| `ops/smoke_pdf_service.py` | 운영 서버(root) | 모의 계정 3개로 PDF 영수증 경로 확인. 인자 없이 = API가 직접 실행하는 방식, `service` = 서비스 방식 |
| `ops/pdf_socket_emulator.py` | 시험 컨테이너 | 시험 전용. systemd 없이 소켓 유닛 역할을 대신한다(제한 없음) |

**순서가 강제된다.** 처리기 서비스는 새 API가 배포된 뒤에만 설치된다(이전 API는 소켓을 모른다). 서비스를 쓰는 동안에는 이전 API로 되돌릴 수 없고 먼저 `pdf_service.py rollback`을 해야 한다. 두 경우 모두 스크립트가 사유를 말하고 멈춘다.

`pdf_service.py apply`의 순서: 점검 → 기록(`/home/mmm/backups/pdf-service-20261106/record.json`) → 계정 생성 → 유닛 3개와 drop-in 작성·`daemon-reload` → 소켓 활성화(자체 점검이 먼저 실행된다) → 확인 → API 재시작 → 확인.

확인하는 것: 서비스 환경의 자체 점검 6항목, 소켓의 소유·권한, API 계정으로 알려진 쪽을 그려 픽셀 대조(일반 실행과 API 서비스와 같은 제한 안에서 각각), 읽을 수 없는 PDF 거부, 다른 계정의 접속 거부, **실행 중인 처리기 하나를 밖에서 들여다본 결과**(계정, 권한 상승 금지, 필터, 능력 0, 보이는 일반 파일이 처리기 파일 하나, 네트워크 장치가 루프백 하나, cgroup 메모리 한도와 스왑 0), API가 소켓 설정으로 재시작됐는지, 다른 서비스와 실행 파일 불변.

**복구**: 첫 변경 뒤 어디서든 실패하면 `apply`가 스스로 되돌린다(소켓·유닛·drop-in 삭제 → API 재시작 → 계정 삭제). 적용 뒤에는 `pdf_service.py rollback`이 같은 일을 한다. 그 순간 그리던 쪽이 있으면 그 처리기는 종료되고 API는 그 요청 하나를 실패로 답한다.

## 스테이징 결과 (2026-11-06 16:29~16:36 KST, 커밋 `4a3814c108430bdc53882000bfec25c068bac38f`)

| 단계 | 결과 |
|---|---|
| 빌드 | fmt·Clippy 통과, Rust 단위 시험 61 통과·2 제외(소켓 전송 시험 1건 추가). 처리기·웹·마이그레이션 소스는 16차와 동일. 처리기 자체 점검 통과 |
| 시험(API가 직접 실행) | 개인정보 회귀 11묶음 **99그룹** 통과 |
| 시험(소켓 경유) | PDF 묶음 **7그룹** 통과. 요청 35건이 모두 소켓을 거쳤다(읽기 증빙 13건보다 많다: 거부된 문서와 미리보기·제공 때의 재렌더링 포함) |
| 패키징 | API `0d28667f3c21af82a43b987a12eec2836547d3717c69ae304688c6e5363ce826`. 같은 소스를 두 번 빌드해 같은 해시가 나왔다 |

### systemd 리허설

빌드 호스트의 격리 컨테이너(Ubuntu 22.04, systemd 249 (249.11-0ubuntu3.23))에 **오늘의 운영 상태**를 만들었다: 16차 API·처리기 바이너리, 1단계 스크립트로 적용한 `gps-api` 계정(운영과 같은 drop-in 디렉터리 권한 700까지), 타이머 2개, 무관한 서비스 2개, 내부망의 임시 DB.

| 단계 | 결과 |
|---|---|
| 시작 상태 | 16차 릴리스, API·정리 작업이 `gps-api`, 처리기는 API가 실행 |
| 새 API 배포 전 `pdf_service.py check` | 거부("그 릴리스를 먼저 배포"), 변경 없음 |
| API `check` | 통과, 변경 없음 |
| 새 API가 정상 상태가 되지 못하게 만든 `apply` | 이전 바이너리로 자동 복귀, 다시 `check` 통과 |
| API `apply` | 통과. 스키마·웹·처리기 파일 불변, 처리기는 여전히 API가 실행. 기능 확인 통과 |
| API `rollback` → 다시 `apply` | 통과 |
| 서비스 `check` | 통과, 변경 없음 |
| 처리기를 서비스 환경에서 증명하지 못하게 만든 `apply` | 자동 복구: 계정·유닛·API가 적용 전과 같음 |
| API가 서비스로 전환된 뒤 마지막 확인이 실패하게 만든 `apply` | 자동 복구: 위와 같음 |
| 서비스 `apply` | 통과. 처리기는 `gps-pdf`, 권한 상승 금지, 필터 있음, 능력 0, **보이는 파일은 처리기 파일 하나**, 네트워크 장치는 `lo` 하나, 메모리 한도 832MiB·스왑 0. `gps-api`만 접속 가능(`mmm`·`gps-pdf`·`nobody` 거부). 기능 확인 통과: 쪽 요청 9건을 서비스가 처리 |
| 서비스 사용 중 API `rollback` | 거부("먼저 `pdf_service.py rollback`"), 변경 없음 |
| **쪽을 그리는 도중** 서비스 `rollback` | 통과. 그 처리기는 종료되고 계정·유닛·소켓이 사라짐. `/etc/passwd`·`group`·`shadow`·`gshadow`가 적용 전과 바이트 단위로 같음. 기능 확인 통과(API가 다시 직접 실행) |
| 다시 서비스 `apply` 후 **호스트 재부팅** | API·타이머·소켓이 스스로 올라옴, 순서 충돌 0건, 실패 유닛 변화 없음. 기능 확인 통과(쪽 요청 9건을 서비스가 처리) |
| 운영 진입 게이트 | 두 스크립트 모두 이 리허설 기록만 통과 |

기능 확인이 다루는 것: 합성 2쪽 PDF 영수증의 1·2쪽 렌더링(1414×707, 1000×1000, 픽셀 대조), 없는 쪽 거부, 읽을 수 없는 PDF와 암호 PDF 거부(읽기 증빙 없음), 영역 선택·미리보기·제공·다운로드, 원본 변경 시 무효화, 모의 계정 3개 이용 종료. 서비스 방식에서는 추가로 API 프로세스에 소켓 설정이 있고, 소켓이 센 접속 수가 늘었고, API 쪽에 남은 처리기 프로세스가 없음을 본다.

기록: [pdf-service-rehearsal.json](evidence/infra-round1-20261106/pdf-service-rehearsal.json), [pdf-service-validation.json](evidence/infra-round1-20261106/pdf-service-validation.json). 스크립트 SHA-256은 `pdf_service.py` `3dbbe5a9e5d6eab7bf757b070623236f5c14155ce33c4f3cfc4addcd1e172df5`, `release_pdf_service.py` `e43460d0ea839f64a09782dbe11833c92874bd9e71e3f8eebf36db147ce0d6a0`, `smoke_pdf_service.py` `09dc86c8ce5a6949edd45833ccfff4264e1b6ec06d6daf16c406a55d5936d901`.

**리허설이 다루지 못한 것**

- 운영 커널은 5.15.0-151이고 리허설 호스트의 커널은 6.8.0-142다(같은 Ubuntu 22.04 사용자 공간). systemd도 같은 249지만 배포판 패치 수준이 다르다(운영 `3.16`, 리허설 `3.23`). 처리기 자체 점검은 16차부터 운영 커널에서 통과하고 있으나, **서비스 환경 옵션이 운영 커널에서 성립하는지는 `pdf_service.py apply`가 그 자리에서 확인**하고 실패하면 스스로 되돌린다.
- 운영 서버의 다른 서비스(dev-gps, Shield, nginx, PostgreSQL, docker)와의 공존, `https://gps.serial.kr`을 통한 health, 실제 사용자의 요청.
- 리허설의 API는 `APP_ENV=test`이고 임시 DB의 관리자 계정을 썼다.

## 운영 전송·점검 (2026-11-06 16:37 KST)

- 전송 전 읽기 전용 확인: 커널 5.15.0-151, systemd 249, cgroup v2(메모리 제어 가능), 필요한 도구 있음, 가용 메모리 1572MiB + 스왑 3803MiB, 디스크 여유 4.8G. `gps-pdf` 계정·유닛·소켓 디렉터리·이전 시도 기록 없음. 처리기 파일까지의 경로가 다른 계정에 열려 있음(755).
- 빌드 호스트의 `out/` 10개 파일을 운영 서버 `/home/mmm/gps-artifacts/pdf-service-20261106`으로 옮겼다. 해시 8개가 양쪽에서 같고 API 755·자격증명 600 권한이 유지됐다. 자격증명은 PC에 저장하지 않았다.
- `release_pdf_service.py check`: **통과, 변경 없음.** 운영은 `privacy-pdf-20261106-r1`(API `b6ac9edb…`), 처리기 자체 점검은 `gps-api` 계정으로 6항목 통과. [기록](evidence/infra-round1-20261106/pdf-service-release-check.json)
- `pdf_service.py check`: 예상대로 거부("그 릴리스를 먼저 배포"). 새 API가 배포되기 전이기 때문이다.
- 점검 뒤 확인: API 재시작 없음(15:32:43 KST 그대로), 계정·유닛·기록 디렉터리 생기지 않음, 남은 처리기 프로세스 없음, health 정상.

## API 릴리스 적용 (2026-11-06 16:44 KST, 사용자 승인 뒤 에이전트 실행)

- `release_pdf_service.py apply` 통과(16:44:00~16:44:12 KST). API는 **16:44:02 KST에 새 바이너리로 재시작**됐다(정지 시작부터 수신 대기까지 약 0.08초). health는 외부·서버 모두 `pdf-service-20261106-r1`.
- 스크립트가 확인한 것: 새 API 정상, 처리기 자체 점검 6항목(`gps-api` 계정), API 서비스에 시스템 호출 필터 없음, 스키마·환경파일·웹 링크·처리기 파일 불변, dev-gps·Shield 불변, 기존 수집 정책 불변, 타이머 활성. [기록](evidence/infra-round1-20261106/pdf-service-release-apply.json)
- 에이전트가 따로 확인한 것(읽기 전용): 실행 중인 바이너리 해시 `0d28667f…`, 계정 `gps-api`·능력 0·권한 상승 금지 그대로, API에 소켓 설정 없음(처리기는 이전처럼 API가 실행), 스키마 98, 웹은 16차 그대로, API 오류 로그 0건, 재시작 뒤 단말기 수집 200. 다른 서비스 7개는 재시작되지 않았다.
- 재시작 순간의 5xx는 1건이고 배포 스크립트 자신의 `GET /health` 확인 요청이다(16:44:02, 502). 단말기·사용자 요청의 5xx는 없다.
- 이전 바이너리는 `/home/mmm/backups/pdf-service-20261106-r1/api.previous`에 있다.

### 기능 확인 — API가 직접 실행하는 방식 (16:45:01~16:45:19 KST)

`smoke_pdf_service.py`가 모의 계정 3개(62·63·64)로 통과했다(요청 37, 제공 6). 1쪽(1414×707)·2쪽(1000×1000) 렌더링과 픽셀 대조, 없는 쪽 거부, 읽을 수 없는 PDF와 암호 PDF 거부(읽기 증빙 없음), 영역 선택·미리보기·제공·다운로드, 원본 변경 시 무효화. API에 소켓 설정이 없고 처리기는 API가 실행했음을 확인했다. 실행 뒤: 임시 이미지 0건, 모의 영수증 0건, 모의 계정 3개 이용 제한, 남은 처리기 프로세스 0, API 오류 0건, 실제 계정·SIM 소유 불변, 외부 발송 없음. [기록](evidence/infra-round1-20261106/pdf-service-smoke-child.json)

### 처리기 서비스 읽기 전용 점검 (16:45:30 KST)

`pdf_service.py check`: **통과, 변경 없음.** 만들 것은 계정 `gps-pdf`, 유닛 3개, API drop-in 1개, 소켓 `/run/gps-pdf-render/render.sock`(root:gps-api 660)이고 API 재시작이 한 번 있다. [기록](evidence/infra-round1-20261106/pdf-service-check.json)

## 처리기 서비스 적용 (2026-11-06 16:48 KST, 운영자 실행)

- 운영자가 `pdf_service.py apply`를 실행했고 통과했다. 자체 점검은 서비스 환경에서 16:48:30~16:48:34 KST에 실행됐고, API는 **16:48:39 KST에 소켓 설정으로 재시작**됐다(정지 시작부터 수신 대기까지 약 0.06초).
- 스크립트가 **운영 커널(5.15.0-151)에서** 확인한 것: 서비스 환경의 자체 점검 6항목 통과. 실행 중인 처리기 하나를 밖에서 본 결과 계정 `gps-pdf`, 권한 상승 금지, 시스템 호출 필터 있음, 능력 0, **보이는 일반 파일은 처리기 파일 하나**, 네트워크 장치는 `lo` 하나, cgroup 메모리 한도 832MiB·스왑 0. API 계정으로 알려진 쪽을 그려 픽셀이 일치(일반 실행, API 서비스와 같은 제한 안에서 각각), 읽을 수 없는 PDF 거부, 다른 계정(`nobody`) 접속 거부. 다른 서비스와 실행 파일 불변. [기록](evidence/infra-round1-20261106/pdf-service-apply.json)
- 에이전트가 따로 확인한 것(읽기 전용):
  - 계정 `gps-pdf`(uid 996, 로그인 셸 없음, 홈 없음, 소속 그룹 없음). sudo 불가, 환경파일·업로드 디렉터리 읽기 불가, docker 소켓 쓰기 불가.
  - 소켓 `root:gps-api 660`, 활성·부팅 시 자동 시작 등록. 배포 계정 `mmm`은 sudo 없이 접속하면 거부된다(`Permission denied`).
  - API 프로세스에 `GPS_PDF_SOCKET` 설정이 있고 계정·능력 0·권한 상승 금지는 그대로다. 실행 중인 바이너리 해시 동일.
  - health 외부·서버 정상, API 오류 로그 0건, 재시작 뒤 단말기 수집 200, GPS 경로 5xx 0건, 실패 유닛 없음, 부팅 순서 충돌 메시지 0건.
  - 레거시 `gps-tracker`, `pm2-mmm`, dev-gps, Shield, nginx, PostgreSQL, docker는 재시작되지 않았다. 정리 타이머 2개는 계속 성공한다.
  - 적용 기록은 `/home/mmm/backups/pdf-service-20261106/record.json`(root 전용)에 있다.

### 기능 확인 — 서비스 방식 (16:49:29~16:49:46 KST, 에이전트 실행)

`smoke_pdf_service.py service`가 모의 계정 3개(65·66·67)로 통과했다(요청 41, 제공 7). 1쪽(1414×707)·2쪽(1000×1000) 렌더링과 픽셀 대조, 없는 쪽 거부, 읽을 수 없는 PDF와 암호 PDF 거부(읽기 증빙 없음), 영역 선택·미리보기·제공·다운로드, 원본 변경 시 무효화. **쪽 요청 9건을 별도 서비스가 처리했고**(소켓 접속 수 4 → 13) API 쪽에서 처리기가 실행된 흔적은 없다. 실행 뒤: 임시 이미지 0건, 모의 영수증 0건, 모의 계정 3개 이용 제한, 남은 처리기 프로세스·유닛 0, 업로드 디렉터리 파일 0, API 오류 0건, 실제 계정·SIM 소유 불변, 외부 발송 없음. [기록](evidence/infra-round1-20261106/pdf-service-smoke-service.json)

### 아직 확인하지 못한 것

- **실제 재부팅 뒤의 자동 복귀**는 리허설 호스트에서만 확인했다. 운영 서버를 이 목적으로 재부팅하지 않았다. 다음 계획된 재부팅 때 `systemctl is-active gps-pdf-render.socket`과 health를 본다.
- 실제 한글 영수증 PDF는 여전히 표본이 없다(16차부터의 미확인 항목).

## 운영 반영 순서 (완료)

| 순서 | 실행 | 내용 |
|---|---|---|
| 1 ✅ | 에이전트(사용자 승인 뒤) | `release_pdf_service.py apply` — API 바이너리 교체, 재시작 1회. 16:44 KST 완료 |
| 2 ✅ | 에이전트 | `smoke_pdf_service.py` — 새 API가 이전 방식 그대로 PDF를 처리하는지 확인. 16:45 KST 통과 |
| 3 ✅ | 에이전트 | `pdf_service.py check` — 읽기 전용. 16:45 KST 통과 |
| 4 ✅ | **운영자** | `pdf_service.py apply` — 계정·유닛 생성, API 재시작 1회. 16:48 KST 통과 |
| 5 ✅ | 에이전트 | 읽기 전용 확인과 `smoke_pdf_service.py service`. 16:49 KST 통과 |

4번을 운영자가 실행하는 이유는 1단계와 같다. 계정 생성과 서비스 실행 환경 변경은 서버의 시스템·보안 설정 변경이고, 에이전트는 승인이 있어도 이 종류의 변경을 직접 실행하지 않는다. 1번은 애플리케이션 배포(바이너리 교체)라 승인 뒤 에이전트가 실행한다.

```bash
ssh -t seriallog "cd /home/mmm/gps-artifacts/pdf-service-20261106 && sudo python3 pdf_service.py apply"
```

되돌리려면 같은 자리에서 `sudo python3 pdf_service.py rollback`, 그다음 필요하면 `sudo python3 release_pdf_service.py rollback`.

## 남은 작업

- [x] 운영 반영 1~3: API 릴리스 적용, 기능 확인, 서비스 읽기 전용 점검(2026-11-06 16:44~16:45 KST).
- [x] 운영 반영 4: 운영자가 `pdf_service.py apply` 실행(16:48 KST).
- [x] 운영 반영 5: 확인과 서비스 방식 기능 확인(16:49 KST), 문서·인계·PR·증빙 갱신.
- [ ] 다음 계획된 재부팅 때 소켓과 health 확인(위 "아직 확인하지 못한 것").
- 이후 릴리스 스크립트는 처리기를 서비스로 쓰는 구성을 전제로 해야 한다. 특히 **처리기 파일을 바꾸는 릴리스**는 교체 뒤 `systemctl restart gps-pdf-render-selftest.service`로 새 파일을 그 환경에서 다시 증명해야 한다. 소켓은 `PartOf=`로 함께 다시 시작되고 증명이 실패하면 올라오지 않도록 구성했다. 이 경로는 구성상의 동작이며 리허설에서 따로 시험하지 않았으므로, 그런 릴리스를 만들 때 리허설에 넣는다.
- 다음 라운드: [VPS와 독립된 외부 장애 감시](infra-round2-external-watch-20261106.md)(진행 중). 그다음 기능 라운드: 권리 대응 17차(수집·이용·제공사실 열람).
- 별도 항목(이 라운드와 섞지 않음): 방화벽 부팅 순서, 디스크 정리, 열린 포트, 회사 데이터 파기 정책.
