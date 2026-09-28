# UNO GNSS 배치 v11 검증 — 2026-09-28

## 변경

SIM7080G GNSS를 5초마다 조회하는 기존 정책을 유지하고, 유효 측정값을 GNSS UTC 기준 10초 이상 간격으로 최대 8개 보존한다. 위도/경도는 microdegree 정수로 저장하여 AVR float 출력의 정밀도 손실과 큰 JSON 버퍼를 피했다. 기존 60초 POST 대기, GNSS off → HTTP → GNSS on 순서, 120/600초 측위 대기, 품질 검증은 유지한다.

전체 본문을 RAM에 복제하지 않고 192-byte 조각으로 길이를 계산한 뒤 같은 표본을 순차 전송한다. 새 주소는 `/ingest/shield`, 형식은 `shield_v:1`과 `points:[[UTC초,lat_e6,lng_e6,sat_view],...]`다. 서버의 기존 IDF/KC `/ingest` 파서와 별개이다. `SHIELD_DEV_TARGET=1`은 dev-gps.serial.kr로 한정하며 일반 기본값은 gps.serial.kr이다.

HTTP 200 이전에는 표본을 유지하고, 같은 UTC를 재전송하여 서버에서 중복을 제거한다. 8개 초과 시 오래된 표본을 교체하며 10분 이상 지난 표본은 만료시킨다. 재부팅/전원 차단과 통신 실패 중 GNSS 중단 때문에 장기 오프라인 전 구간 보존은 보장하지 않는다.

## 빌드

Arduino CLI 1.2.0, AVR core 1.8.6, U8g2 2.36.12, UNO, `--warnings all`.

| 대상 | 플래시 / 32,256 | 전역 RAM / 2,048 |
| --- | ---: | ---: |
| v10 prod 일반(이전) | 25,500 | 1,305 |
| v11 prod 일반 | 26,648 | 1,448 |
| v11 dev 일반 | 26,656 | 1,448 |
| v11 dev 진단 | 29,664 | 1,476 |

일반 빌드는 전역 RAM 제외 600 bytes가 남는다. 진단 빌드 HTTP 함수에서 관측한 여유 RAM은 528 bytes다. 이는 JSON 인코더 및 인터럽트의 최대 스택 깊이를 포함하는 실행 중 최소 여유 RAM 측정이 아니므로 두 값을 혼동하지 않는다. 설치된 U8g2/AVR core의 기존 경고는 남으며 스케치 경고는 없었다.

HEX는 `%LOCALAPPDATA%/GPS-Builds` 아래 각각 `uno-shield-20260928-v11`, `-v11-dev`, `-v11-dev-dbg`에 보관한다.

- prod 일반: `803e07cbf549e3adbe459df1ace9d32eef5b62b456a4aafaffe1b5a9060dc9c9`
- dev 일반: `007c9ed601e8bd0bd9a0dee5921b21df0076fdbec3c02ef39a56441b75f25352`
- dev 진단: `ba1e8d5d4c6db9264297677e51c4958d02638d39443c30f853d2159a0409545f`

## 시험

etcom-hub에서 실제 스케치를 호스트 모뎀 스텁과 C++17/ASan/UBSan/`-Wall -Wextra -Werror`로 일반/진단 모두 검증했다. UTC 날짜·윤년·초 변환, 소수 좌표와 음수 경계, 큐 포화, 10초 샘플링, TTL과 millis wraparound, 실패 보존/성공 비움, 스트리밍 길이, 기존 GNSS/HTTP 복구·지연 프롬프트·재부팅·자동 재시도 시험을 통과했다. 실제 생성한 JSON 1점/0점/8점을 별도 JSON 파서로 확인했다.

실기는 COM26에서 dev 진단 및 일반 빌드를 각각 `upload --verify`로 기록했다. 수동 RF/PWRKEY 시험은 하지 않았다. 정상 HTTP 200 배치 수신을 시리얼과 dev DB 양쪽에서 확인했다.

- 진단 빌드: 위치 배치 6건, 총 34점.
- 일반 빌드: 위치 배치 3건, 총 18점. 점 간격 10~14초이며 17점의 서버 계산 속도가 유효했다. 첫 점은 이전 no-fix 구간과의 단절 때문에 미확정이다.
- 두 빌드 합계 52점 중 49점의 속도가 유효했다. 60초 초과 간격 1개(92초)는 진단→일반 펌웨어 재업로드 구간이다.
- 저장 source는 `lte_gnss`이며 실제 GNSS 측정 UTC를 보존한다. dev 장치 3478, dev 사용자 `user@user.com`(25)으로 지도 조회 경로를 검증했다.
- 별도 합성 서버 시험에서 WebSocket의 모든 점과 이력 REST 응답의 시각/속도 일치를 확인했다. 실제 브라우저 지도 모양을 자동 검증한 것은 아니다.

좌표가 한곳에 고정된 장치에서도 흔들렸고 일반 빌드에서 계산된 최대 속도는 7.78km/h였다. 이는 실제 이동이 확인된 값이 아니며 이번 전송 개선이 GNSS 드리프트를 제거했다는 의미가 아니다. 공통 UI의 미확정 속도/정지 아이콘 및 실시간·이력 마커 선정 차이도 이번에는 변경하지 않았다.

## 운영 반영 완료

명시적 승인 후 12:51:52 KST prod API에 `dev-20260928-123509-e2bb6e0`과 HTTP/HTTPS 전용 `/ingest/shield` 경로를 반영했다. 운영 환경 값은 production이며 릴리스 이름은 빌드 식별자다. 웹 SPA, DB 마이그레이션(65/65), 환경 파일, KC 진단 페이지 및 기존 IDF 수신 파서는 변경하지 않았다. 이후 COM26에 위 해시의 prod 일반 v11을 `upload --verify`로 업로드했다.

원본 시리얼은 개인 `%LOCALAPPDATA%/GPS-Monitoring/shield-batch-v11-20260928` 및 `shield-batch-v11-normal-20260928`에 보관한다. 진단 로그에 실제 좌표가 있으므로 저장소에 포함하지 않는다. `03_8`, `idf_caltest`, KC 펌웨어는 수정하지 않았다.

prod 실기 확인: 4분 관찰 중 12:54:24~12:56:32 KST에 위치 배치 3건/18점이 저장됐다. 점 간격 10~14초, 유효 속도 17점이며 첫 점은 이전 no-fix와의 단절로 미확정이다. 장치 3015는 `user@user.com`(25)에 계속 귀속되어 있다. API ERROR/panic은 0건이다. 일반 v11(`shield-batch-20260928-v11`)을 실행 중이며 모든 시리얼 모니터를 종료했다. 운영 검증 로그는 개인 `%LOCALAPPDATA%/GPS-Monitoring/shield-batch-v11-prod-20260928`에 보관한다.
