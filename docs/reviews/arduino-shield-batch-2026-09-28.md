# UNO GNSS 배치 수신 — 2026-09-28

## 범위와 배포 상태

쉴드 v10은 60초 대기와 HTTP 작업 후 최신 좌표 한 개만 전송하여 실제 점 간격이 약 64초였다. 공통 속도 계산/지도 단절 기준 60초를 정상 전송에서도 넘었다. v11은 통신 주기를 유지하면서 중간 GNSS 측정값을 보존한다.

- 펌웨어 브랜치 `codex/uno-shield-http-recovery`, 구현 커밋 `79771fa`, PR #244.
- API 브랜치 `codex/uno-shield-monitor`, 구현 커밋 `efb10f5`, `e2bb6e0`, PR #245.
- dev 활성 릴리스: `dev-20260928-123509-e2bb6e0`. API SHA-256 `81214c4f4c49ee361a92271f913271ccc9bc633b7d0e41e51807df945cae79d9`.
- 명시적 승인 후 **12:51:52 KST** prod에 `dev-20260928-123509-e2bb6e0`을 배포했다. release 이름은 빌드 식별자이며 환경은 production이다.
- 웹 SPA와 DB 마이그레이션은 변경하지 않았다. DB는 65/65 유지.

## 독립된 형식과 기존 호환성

공개 `POST /ingest/shield` → 내부 `/gps-tracker/ingest/shield` → `routes/shield_ingest.rs`만 사용한다. `routes/ingest.rs`, `routes/diag.rs`, KC/IDF 펌웨어, 공통 속도 함수는 변경하지 않았다. nginx에는 기존 `/ingest` 블록을 수정하지 않고 별도의 exact 경로를 HTTP/HTTPS 각각 추가한다(8KB 제한).

쉴드 v1 형식:

```json
{"device_uid":"uno-shield-test","shield_v":1,"build_tag":"shield-batch-20260928-v11","ts":120,"csq":20,"reg":5,"diag":{"pv_mv":4100,"gnss":10},"points":[[1790586000,37000000,127000000,8]]}
```

`points`는 `[GNSS UTC 초, 위도 microdegrees, 경도 microdegrees, 가시 위성 수]`의 오름차순 배열이다. 위 예시는 합성 좌표이며 실제 위치가 아니다. 서버는 최대 8개, 좌표 범위, 위성 수, UTC 순서와 나이(과거 15분/미래 30초), 메타데이터를 쓰기 전 검증한다. `uno-shield-` 접두사와 형식 버전이 필수이며 legacy `lte`, `l80`, `fixes` 혼합도 거부한다.

서버는 `source=lte_gnss`, 한 row와 `fixes_jsonb`로 저장한다. 실제 측정 UTC가 anchor/offset이 되며 수신 지연을 속도로 오인하지 않는다. 장치 행 잠금 아래 owner_id를 유지하고 현재 소유자의 이력으로 저장한다. 같은 UTC의 재전송/겹친 배치는 중복 제거한다. 오래된 backfill은 장치 최신 위치를 되돌리지 않고 geofence를 재생하지 않는다. 비어 있는 배열은 no-fix 상태 보고다. 통신 복구 이벤트도 재전송 간 한 번만 생성한다.

저장 후 기존 `location_speed_points_between`으로 각 점의 속도를 계산하여 WebSocket `fixes` 배열과 top-level 최신 점에 실어 보낸다. 쉴드만을 위한 속도 추정식이나 60초 임계값 완화는 추가하지 않았다.

## 검증

- etcom-hub에서 Rust fmt/clippy, 단위 시험 11개, 격리 DB FCM 시험 1개, 웹 시험 29개 및 release build 통과. VPS에서는 컴파일하지 않았다.
- `ops/test_shield_batch.py`: 한 row/6점 저장, UTC/고정소수점 좌표, 알려진 약 4km/h, 기존/다른 소유자 격리, 정확한 재전송 및 일부 겹침, backfill 최신 위치 보호, 잘못된 입력의 쓰기 전 거부, no-fix, 소유권 변경, 복구 알림 1회, WebSocket/REST의 점별 속도 일치, 기존 L80 배치 응답 검증 통과.
- `ops/test_app_fcm_kc.py`: KC 익명 no-fix 수신, unpaired scan, UID pair, 원격 명령 없는 응답, DHT/공개 진단, 기존 FCM/알림 정책 회귀 시험 통과.
- dev API 교체 전/후 KC 진단 및 SPA 페이지 SHA-256 동일. prod API와 nginx SHA-256은 준비 시점과 동일함을 별도 확인했다.
- 실기 COM26에서는 v11 진단 및 일반 빌드를 dev로 한정하여 시험했다. dev 장치 ID 3478은 dev의 `user@user.com`(25)에 연결했다. prod의 장치 3015 및 소유권은 변경하지 않았다.

## 운영 반영 준비

운영 승인을 받은 뒤 **API와 nginx 경로 배포 → prod용 일반 v11 업로드** 순서로 진행한다. 운영 경로가 없는 상태에서 v11을 prod에 연결하지 않는다.

- 배포 도구: `ops/deploy_shield_batch.py`의 prepare/apply. prepare는 백업과 사전 상태/예정 nginx만 작성하며 운영 서비스는 변경하지 않는다.
- 산출물: VPS `/home/mmm/gps-artifacts/dev-20260928-123509-e2bb6e0`, Windows `%LOCALAPPDATA%/GPS-Builds/dev-20260928-123509-e2bb6e0`.
- prod 준비/롤백: `/home/mmm/backups/gps-shield-batch-prod-dev-20260928-123509-e2bb6e0` 및 Windows 같은 이름의 `%LOCALAPPDATA%/GPS-PrivateBackups` 폴더.
- prod 백업 SHA-256: `daf43113b4f952a1556879a2b897d26e6f6b346338e2ad9204519738590c909b`. 외부 복사 및 해시 검증 완료. `offsite-verified.json` 준비 완료.
- prod용 일반 v11 HEX: `%LOCALAPPDATA%/GPS-Builds/uno-shield-20260928-v11/03_10_uno_shield_gps_oled.ino.hex`, SHA-256 `803e07cbf549e3adbe459df1ace9d32eef5b62b456a4aafaffe1b5a9060dc9c9`.
- 배포 스크립트는 API/환경/nginx/스키마가 준비 시점과 같을 때만 적용하며, 실패 시 API와 nginx를 복원한다. schema/SPA/기존 KC 페이지 및 기존·신규 endpoint의 거부 응답을 검사한다.

## 남는 한계

이는 중간 좌표 보존과 시각 정합성 개선이다. 고정 장치의 GNSS 흔들림, 공통 UI의 미확정 속도 아이콘/실시간·이력 마커 선정 차이는 별도 문제로 남는다. 최대 8개 RAM 큐는 전원 재시작 시 유실되고, 통신 복구 중 GNSS 중단과 10분 표본 만료 정책이 있어 장기 오프라인 전 구간 기록은 보장하지 않는다. 일반적인 위치 업로드의 익명 식별 정책도 이번에는 변경하지 않았다.

실기 검증 최종: 진단 6배치·34점, 일반 3배치·18점(10~14초 간격, 17점 속도 계산). 이후 v10으로 복귀했고 12:47:00 KST prod 장치 3015/사용자 25에 유효 위치가 저장됐다. prod API/기존 nginx는 변경하지 않았으며 COM26 모니터도 모두 종료했다.

## prod 배포 완료

사용자가 API → 펌웨어 순서의 배포를 명시 승인했다. 사전 검토에서 동일한 HTTP/HTTPS 블록에 str.replace를 반복할 때 첫 서버에 경로가 중복되는 준비 도구 오류를 발견했다. 각 원본 일치를 한 번씩 처리하도록 수정하고 두 가지 회귀 시험과 실제 예정 nginx 전체 설정의 `nginx -t`를 통과한 뒤 적용했다. 기존 설정을 바꾸기 전에 발견·수정했으며 KC 서비스 롤백/실패 배포는 발생하지 않았다.

API 교체 후 KC 진단·SPA 페이지 해시 동일, 기존/신규 HTTP·HTTPS 수신 경로 거부 응답 정상, schema 65/65를 확인했다. 기존 IDF ingest·diag·속도 함수는 소스 diff가 없으며, 환경 파일도 동일하다. COM26에 prod 일반 v11을 verify 업로드하고 4분간 관찰했다. 12:54:24~12:56:32 KST 위치 배치 3건/18점, 점 간격 10~14초, 17점 속도 계산을 확인했다. 장치 3015는 user@user.com(25)에 계속 귀속되어 있다. API ERROR/panic은 0건이며 시리얼 모니터는 종료했다. 이후에도 단말은 prod 일반 v11로 계속 작동한다.
