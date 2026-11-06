# 인프라 1차 — API 실행 계정과 PDF 처리기 권한 분리

2026-11-06 · GPS 운영 서버(`gps.serial.kr`) · `codex/location-business-prep`

> **상태: 1단계(실행 계정 분리) 운영 적용 완료(2026-11-06 15:32 KST, 운영자 실행), 기능 확인 통과(15:37 KST).** API와 정리 작업 2개가 sudo·docker 권한이 없는 `gps-api` 계정으로 실행 중이다. 2단계(PDF 처리기의 별도 계정·서비스 분리)는 [별도 문서](infra-round1-pdf-service-20261106.md)에 있다: 새 API 릴리스는 운영 적용·기능 확인 완료(16:44 KST), 처리기 서비스 자체는 운영자 실행 대기.

## 배경

운영 API와 정리 작업 두 개가 배포 계정 `mmm`으로 실행된다. 이 계정은 비밀번호 없는 전체 sudo와 docker 그룹 권한을 가진다. API나 그 자식 프로세스(PDF 처리기)가 뚫리면 서버 전체 권한으로 이어진다([사전 조사](infra-precheck-20261106.md), 준비 문서 S1의 P0).

이번 라운드는 이 실행 권한만 줄인다. **방화벽 변경, 디스크 정리, 회사 데이터 파기 정책은 섞지 않는 별도 항목**이다.

## 조사: API가 쓰는 것

운영 서버를 읽기 전용으로 조사했다(값이 아니라 경로·소유·권한만 읽었다).

| 대상 | 현재 | 분리 후 |
|---|---|---|
| 서비스 `gps-tracker-api` | `mmm`, 보호 옵션 없음 | `gps-api`, 아래 보호 옵션 |
| 정리 작업 `gps-privacy-accounts`, `gps-privacy-files`(타이머 2분) | `mmm`, 기존 보호 옵션 있음 | `gps-api`, 기존 옵션 그대로 |
| 환경파일 `/home/mmm/projects/gps-tracker-api/.env` | `mmm:mmm 600` | `root:gps-api 640`(읽기만 가능, 수정은 root) |
| FCM 키 `/etc/gps-tracker/fcm-service-account.json` | `mmm:mmm 600` | `root:gps-api 640`. API가 시작할 때 읽으므로 읽지 못하면 기동하지 못한다 |
| 업로드 `/home/mmm/uploads`, `/home/mmm/gps-private-uploads` | `mmm:mmm`, 750/700 | 소유만 `gps-api:gps-api`, 권한 그대로 |
| 실행 파일(API, PDF 처리기), 정리 스크립트 | `root:root 755/644` | 그대로 |
| DB | TCP `127.0.0.1` + 비밀번호(`gps_tracker_app`, 슈퍼유저 아님) | 그대로. OS 계정에 의존하지 않는다 |
| 임시 파일 | 쓰지 않음(소스에 임시 파일·임시 디렉터리 사용 없음) | 서비스 전용 `/tmp` |
| 자식 프로세스 | PDF 처리기 하나 | 같은 계정·같은 제한 안에서 실행 |

nginx는 업로드 디렉터리를 직접 제공하지 않는다(API가 읽어서 응답). 환경파일을 읽는 다른 서비스나 스크립트는 없었다.

## 변경 내용 (1단계: 실행 계정)

- **계정** `gps-api`: 시스템 계정, 로그인 셸 없음, 홈 없음, 추가 그룹 없음(sudo·docker 아님).
- **서비스 설정**: 단위 파일은 건드리지 않고 drop-in(`10-runtime-account.conf`)을 세 서비스에 하나씩 추가한다. API에는 다음을 적용한다.

  | 옵션 | 효과 |
  |---|---|
  | `User`/`Group=gps-api`, `SupplementaryGroups=` | 실행 계정 전환 |
  | `NoNewPrivileges=yes` | setuid 프로그램(sudo 등)으로 권한을 얻을 수 없음 |
  | `CapabilityBoundingSet=`, `AmbientCapabilities=` | 능력 전부 제거 |
  | `ProtectSystem=strict`, `ProtectHome=read-only` | 파일 시스템 전체 읽기 전용 |
  | `ReadWritePaths=`업로드 두 곳 | 쓰기는 업로드 디렉터리에만 |
  | `PrivateTmp=yes`, `ProtectControlGroups=yes`, `UMask=0077` | 전용 `/tmp`, cgroup 읽기 전용, 새 파일은 본인만 |

- **시스템 호출 필터는 이번 단계에 추가하지 않았다.** `ProtectKernelTunables`·`PrivateDevices`·`RestrictSUIDSGID` 등은 필터를 설치한다(리허설 호스트에서 옵션별로 확인). PDF 처리기는 상위 필터가 없는 조건에서 증명됐으므로, 그 조건을 바꾸는 옵션은 처리기 실행 환경을 분리하는 2단계에서 다룬다. 적용 스크립트는 API 프로세스에 필터가 없는지 확인한다.
- **바꾸지 않는 것**: 단위 파일, 실행 파일, 파일 내용, DB, 방화벽, 다른 계정, 다른 서비스(레거시 `gps-tracker`, `pm2-mmm`, dev-gps, Shield, nginx, PostgreSQL, docker). 적용 전후로 이 서비스들의 프로세스가 그대로인지 대조한다.
- **배포**는 지금처럼 `mmm`+sudo로 한다. 릴리스 스크립트는 서비스 계정을 서비스 설정에서 읽으므로 그대로 동작한다. 분리 뒤 `mmm`은 환경파일을 sudo 없이 읽지 못한다.

## PDF 처리기 (단계적 적용)

- **1단계(이번)**: 처리기는 API가 실행하므로 API와 같은 계정·제한을 받는다. sudo·docker 없음, 능력 없음, 권한 상승 금지, 읽기 전용 파일 시스템. 처리기 자신의 제한(파일·소켓·프로그램 실행·프로세스 생성 차단, 메모리 768MiB, CPU 10초, 200쪽, API의 15초 대기 한도)은 그대로 유지된다. 적용 스크립트는 처리기 자체 점검을 `gps-api` 계정으로, 그리고 API 서비스와 같은 제한을 건 임시 단위 안에서 실행해 확인한다.
- **2단계([문서](infra-round1-pdf-service-20261106.md), 리허설 통과·운영 적용 전)**: 처리기를 API와 다른 계정(`gps-pdf`)의 별도 서비스로 옮긴다. 소켓으로 요청을 받아 쪽마다 한 번 실행되는 단위로 두고, 전용 계정·네트워크 없음·처리기 파일만 보이는 빈 루트·cgroup 메모리와 실행 시간 한도를 건다. API가 처리기를 직접 실행하는 대신 소켓으로 요청하도록 바꿨으므로 API 재배포(`pdf-service-20261106-r1`)가 먼저다.

## 절차

| 스크립트 | 실행 위치 | 하는 일 |
|---|---|---|
| `ops/rehearse_runtime_account.py` | 빌드 호스트 | 실제 systemd가 도는 격리 호스트에 운영 구성을 만들고 전체 절차를 리허설. 운영에 접근하지 않는다 |
| `ops/runtime_account.py` | 운영 서버(root) | `check`(읽기 전용) · `apply`(적용) · `rollback`(복구) |
| `ops/smoke_runtime_account.py` | 운영 서버(root) | 적용 뒤 모의 계정 3개로 인증·수집·파일·PDF·정리 작업을 실제 경로로 확인 |

`apply`의 순서: 점검 → 현재 소유·권한·서비스 계정을 기록(`/home/mmm/backups/runtime-account-20261106/record.json`) → 계정 생성 → 환경파일·FCM 키 권한, 업로드 소유 변경 → drop-in 추가·`daemon-reload` → API 재시작 → 확인(프로세스 계정·능력·권한 상승 금지, 계정이 할 수 있어야 하는 일과 없어야 하는 일, 처리기 자체 점검 2종, 정리 작업 각 1회 실행, 다른 서비스와 파일 내용 불변).

**복구**: 첫 변경 뒤 어디서든 실패하면 `apply`가 기록대로 스스로 되돌린다(drop-in 삭제 → 소유·권한 복원 → API 재시작 → 계정 삭제). 적용 뒤에는 `python3 runtime_account.py rollback`이 같은 기록으로 되돌린다. 그 사이 새로 생긴 업로드 파일은 이전 계정 소유로 돌린다.

## 리허설 결과 (2026-11-06)

빌드 호스트의 격리 컨테이너에서 실제 systemd(systemd 249 (249.11-0ubuntu3.23), Ubuntu 22.04)를 띄우고 운영과 같은 구성을 만들었다: sudo·docker 권한을 가진 `mmm`, 같은 경로의 서비스 3개와 타이머 2개, **운영이 지금 실행하는 API·처리기 바이너리**, 같은 계정의 무관한 서비스 2개, 내부망의 임시 DB.

| 단계 | 결과 |
|---|---|
| 기존 구성(`mmm`)에서 기능 확인 | 통과: 인증, 서명된 위치 수집, API가 쓴 파일 읽기, PDF 1·2쪽, 타이머가 실행한 정리 작업 2종 |
| `check` | 통과, 아무것도 바꾸지 않음 |
| 새 설정으로 API가 기동하지 못하게 만든 `apply` | 45초 뒤 자동 복구. 소유·권한·서비스·계정이 적용 전과 같음. 다시 `check` 통과 |
| 서비스 제한 안에서 처리기를 증명하지 못하게 만든 `apply` | 자동 복구. 다시 `check` 통과 |
| `apply` | 통과. API와 정리 작업이 `gps-api`로 실행, 능력 0·권한 상승 금지·시스템 호출 필터 없음. sudo 불가, 추가 그룹 없음, 이전 환경파일 사본 읽기 불가, 실행 파일 옆 쓰기 불가. 기능 확인 통과(API가 쓴 파일은 `gps-api` 소유 600) |
| `rollback` | 통과. 소유·권한·서비스가 기록대로, 계정 삭제. `mmm`으로 기능 확인 다시 통과 |
| 다시 `apply` | 통과, 기능 확인 통과 |
| 운영 진입 게이트 | 이 리허설 기록만 통과 |

기능 확인이 다루는 것: **인증**(로그인, 토큰 갱신, 틀린 비밀번호 거부), **수집**(HMAC 서명 보고의 저장), **DB**(위 전 과정), **파일**(API가 차량 사진을 쓰고 다시 읽음, 다른 계정 404), **PDF**(설치된 처리기로 1·2쪽 렌더링, 읽을 수 없는 PDF 거부, 영역 제공과 원본 변경 시 무효화), **만료 정리**(타이머가 실행한 파일 정리 작업이 주인 없는 파일을 삭제, 타이머가 실행한 계정 정리 작업이 이용 종료 3건 처리).

기록은 [rehearsal.json](evidence/infra-round1-20261106/rehearsal.json)에 있다. 스크립트 SHA-256 `18dda9f8c2747490c1e0ea5e847216b286182b94bbce7eecef31a9b503ea2276`, 커밋 `1c1a4297daf04a4414c650c47c91c6b7cae81797`.

**리허설이 다루지 못한 것**: 운영 서버의 다른 서비스(dev-gps, Shield, nginx, PostgreSQL, docker)와의 공존, 운영 FCM 키의 실제 내용, `https://gps.serial.kr`을 통한 health, 실제 단말기 수집. 이들은 `check`와 `apply`의 확인, 그리고 적용 뒤 기능 확인에서 본다. 리허설의 API는 `APP_ENV=test`이고 운영 DB 계정 대신 임시 DB의 관리자 계정을 썼다.

## 운영 반영

### 운영 서버 준비와 읽기 전용 점검 (2026-11-06 15:23 KST)

- 리허설을 통과한 스크립트 2개와 기록을 운영 서버 `/home/mmm/gps-artifacts/runtime-account-20261106`에 두었다. 빌드 호스트와 해시가 같다.
- `python3 runtime_account.py check`: 통과, 변경 없음. 운영은 릴리스 `privacy-pdf-20261106-r1`이고 세 서비스 모두 `mmm` 계정으로 실행 중이다. 바뀔 파일은 2개, 업로드 항목은 8개다.
- 점검 뒤 따로 확인: 계정·drop-in·기록 디렉터리가 생기지 않았고 API 재시작도 없었다.

### 적용 (2026-11-06 15:32 KST, 운영자 실행)

- 운영자가 `runtime_account.py apply`를 실행했고 통과했다. API는 **15:32:43 KST에 `gps-api` 계정으로 재시작**됐다(정지 시작부터 수신 대기까지 약 0.07초).
- 스크립트가 확인한 것: API 프로세스의 계정 `gps-api`, 추가 그룹 없음, 능력 0, 권한 상승 금지, 시스템 호출 필터 없음. 계정이 할 수 없어야 하는 11가지(sudo, 환경파일·실행 파일·실행 파일 디렉터리·정리 스크립트 디렉터리·FCM 키 쓰기, sudoers 읽기, docker 소켓, 배포 계정의 SSH 디렉터리, 이전 환경파일 사본 읽기) 모두 거부. PDF 처리기 자체 점검은 `gps-api` 계정으로, 그리고 API 서비스와 같은 제한을 건 임시 단위 안에서 통과. 정리 작업 2개가 `gps-api`로 한 번씩 성공. 다른 서비스와 파일 내용 불변.
- 에이전트가 따로 확인한 것(읽기 전용):
  - 계정 `gps-api`(uid 997, 로그인 셸 없음, 홈 없음, 추가 그룹 없음). 세 서비스가 `gps-api`로 실행.
  - 환경파일·FCM 키는 `root:gps-api 640`, 업로드 두 곳은 `gps-api` 소유(권한 750/700 그대로), 실행 파일은 `root:root 755` 그대로, 실행 중인 바이너리 해시 동일.
  - health가 외부·서버 모두 정상(`privacy-pdf-20261106-r1`), API 오류 로그 없음(권한 거부 없음), 재시작 뒤 단말기 수집 200, GPS 경로 5xx 0건.
  - 레거시 `gps-tracker`, `pm2-mmm`, dev-gps, Shield, nginx, PostgreSQL, docker는 재시작되지 않았다(시작 시각이 변경 전). 배포 계정 `mmm`의 그룹과 sudo 설정은 그대로다.
  - 적용 전 기록은 `/home/mmm/backups/runtime-account-20261106/record.json`(root 전용)에 있다.

### 기능 확인 (15:35:17~15:37:21 KST, 에이전트 실행)

`smoke_runtime_account.py`가 모의 계정 3개(59·60·61)로 실제 경로를 확인했고 통과했다.

| 항목 | 결과 |
|---|---|
| 인증 | 로그인, 토큰 갱신, 틀린 비밀번호 거부 |
| 수집 | 실제 단말기 보고가 재시작 전 10분에 27건, 재시작 뒤 7건 저장됨(모의 위치는 보내지 않음) |
| 파일 | API가 쓴 차량 사진이 `gps-api` 소유·권한 600. 다시 읽기 일치, 다른 계정 404 |
| PDF | 설치된 처리기로 1쪽(1414×707)·2쪽(1000×1000) 렌더링, 읽을 수 없는 PDF 거부(읽기 증빙 없음), 영역 제공·다운로드, 원본 변경 시 무효화 |
| 만료 정리 | 타이머가 실행한 파일 정리 작업이 주인 없는 파일을 삭제, 타이머가 실행한 계정 정리 작업이 이용 종료 3건 처리(두 작업 모두 `gps-api`) |

실행 뒤: 임시 이미지 0건, 모의 영수증·지출·차량 삭제, 모의 계정 3개 이용 종료, 업로드 디렉터리에 남은 파일 없음, 실제 계정·SIM 소유 불변, 외부 발송 없음, API 오류·재시작 없음, 남은 처리기 프로세스 없음, 정리 작업 실패 0건. 기록은 [production-apply.json](evidence/infra-round1-20261106/production-apply.json), [production-smoke.json](evidence/infra-round1-20261106/production-smoke.json).

### 적용 뒤 발견한 스크립트 결함 (동작·보안 영향 없음)

- 적용 스크립트가 drop-in 디렉터리 3개를 **700 권한**으로 만들었다(스크립트의 umask 때문). systemd는 root로 읽으므로 설정은 정상 적용됐지만, 일반 계정의 `systemctl cat`에는 drop-in이 보이지 않는다. 이 서버의 다른 drop-in 디렉터리는 755다.
- 저장소의 스크립트는 고쳤고(만든 디렉터리를 755로) 리허설에 "배포 계정이 `systemctl cat`으로 drop-in을 볼 수 있는지" 확인을 추가했다. 운영에 올라간 스크립트는 리허설 기록과 묶여 있으므로 그대로 두었고, `rollback`은 그 스크립트로 동작한다.
- 운영의 디렉터리 권한을 맞추려면 운영자가 실행한다(선택):

  ```bash
  ssh seriallog "sudo chmod 755 /etc/systemd/system/gps-tracker-api.service.d /etc/systemd/system/gps-privacy-accounts.service.d /etc/systemd/system/gps-privacy-files.service.d"
  ```

### 적용을 운영자가 실행한 이유

계정 생성, 서비스 실행 권한 변경, 파일 소유 변경은 서버의 시스템·보안 설정 변경이다. 에이전트는 사용자 승인이 있어도 이 종류의 변경을 직접 실행하지 않는다(작업 규칙). 그래서 준비·리허설·읽기 전용 점검과 적용 뒤 확인은 에이전트가 하고, **적용 한 줄은 운영자가 실행한다.**

```bash
ssh -t seriallog "cd /home/mmm/gps-artifacts/runtime-account-20261106 && sudo python3 runtime_account.py apply"
```

- API 재시작이 한 번 있다(16차 배포 때 약 0.05초).
- 실패하면 스스로 되돌리고 `STOPPED:`로 사유를 출력한다.
- 되돌리려면 같은 자리에서 `sudo python3 runtime_account.py rollback`.

## 남은 작업

- [x] 운영 적용(2026-11-06 15:32 KST, 운영자 실행)과 적용 뒤 확인·기능 확인 완료.
- [ ] (선택) 운영의 drop-in 디렉터리 권한을 755로 맞추기(위 "스크립트 결함", 운영자 실행).
- [ ] 2단계: PDF 처리기의 별도 계정·별도 서비스 분리 — 새 API 릴리스 운영 적용·기능 확인 완료(16:44 KST), **처리기 서비스 적용은 운영자 실행 대기**([문서](infra-round1-pdf-service-20261106.md)).
- [ ] 이후 릴리스 스크립트는 API가 처리기를 어떻게 쓰는지(직접 실행 / 서비스)를 구분해야 한다. `release_pdf_service.py`는 구분한다. 16차 스크립트의 처리기 점검은 필터가 없는 서비스에서 API가 직접 실행하는 경우만 전제로 한다.
- 다음 라운드: VPS와 독립된 외부 장애 감시. 그다음 기능 라운드: 권리 대응 17차(수집·이용·제공사실 열람).
- 별도 항목(이 라운드와 섞지 않음): 방화벽 부팅 순서, 디스크 정리, 열린 포트, 회사 데이터 파기 정책.
