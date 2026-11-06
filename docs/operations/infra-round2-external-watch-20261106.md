# 인프라 2차 — VPS와 독립된 외부 장애 감시

2026-11-06 · 감시 위치: 사무실 빌드 호스트(`etcom-hub`) · 대상: `gps.serial.kr` · `codex/location-business-prep`

> **상태: 가동 중(2026-11-06 17:22 KST부터).** 사무실 빌드 호스트에서 1분마다 돌고 있고 네 점검 모두 정상이다. 시험 메일은 메일 서버가 받았다(받은편지함 도착은 운영자 확인). **Uptime Kuma 주기 신호는 아직 설정되지 않았다**: 감시 자체가 멈추면 알릴 수단이 없다. Kuma 알림 등록과 Push 모니터 생성이 운영자에게 남아 있다.

## 배경

- 2026-11-06 운영 서버가 약 11시간 동안 밖에서 닿지 않았다(원인은 호스팅 업체의 긴급 업데이트 문제, [기록](incident-20261106-hosting-maintenance.md)). 그동안 아무 알림도 없었다.
- 기존 Uptime Kuma(`status.serial.kr`)는 **감시 대상 서버 안에서** 실행되고, **알림 수단이 0건**이며, GPS는 첫 화면만 본다([사전 조사](infra-precheck-20261106.md)). 서버 전체가 막히면 감시도 같이 멈춘다.

## 운영자 결정 (2026-11-06)

| 항목 | 결정 |
|---|---|
| 알림 수단 | **메일(SMTP)** |
| 감시 위치 | **사무실 빌드 호스트만**. VPS·호스팅 업체와 독립이고, 사무실 망·전원에는 의존한다 |
| Uptime Kuma | **알림 수단을 등록한다.** 감시가 Kuma에 주기 신호를 보내 서로를 본다 |

## 구성

`ops/gps_watch.py` 하나가 1분마다 한 번 돈다. 표준 라이브러리만 쓰고, root 권한·새 패키지·상주 프로세스가 없다(사용자 단위 systemd 타이머).

### 무엇을 보는가 (모두 읽기만 한다)

| 이름 | 확인 | 정상 조건 |
|---|---|---|
| `health` | `GET https://gps.serial.kr/health` | 200, `ok`·`db`가 참, 환경이 `production`. 인증서가 만료돼도 실패로 잡힌다 |
| `ingest` | `GET http://gps.serial.kr/ingest` (단말기가 보고하는 주소) | API가 직접 답하는 405(`Allow: POST`). **위치를 보내지 않으며 아무것도 저장되지 않는다.** API가 죽으면 nginx의 502가 온다 |
| `ssh` | `gps.serial.kr:22` | SSH 배너가 온다. 로그인하지 않는다 |
| `status` | `GET https://status.serial.kr/` | 5xx가 아닌 응답 |

### 판정과 알림

- **한 번의 지연은 장애가 아니다.** 한 점검이 **연속 3회** 실패하면 장애, **연속 2회** 성공하면 복구로 본다. 그래서 장애는 약 3분 뒤, 복구는 약 2분 뒤에 알린다.
- 메일을 보내는 때: 장애 발생, 장애 변화(다른 점검이 추가로 실패하거나 일부가 회복), 장애 지속(60분마다), 복구(장애 시간 포함).
- 메일에는 실패한 점검과 사유, 그때 정상인 점검이 함께 적힌다. 예: SSH는 열려 있는데 `health`·`ingest`만 502이면 API 쪽 문제, 넷 다 응답 없음이면 서버 전체·방화벽·호스팅 쪽 문제로 좁힐 수 있다.
- **감시 위치의 인터넷이 끊긴 경우**: 대상이 실패했을 때만 기준 주소 2곳을 확인하고, 그것도 닿지 않으면 운영 서버의 장애로 세지 않는다. 5분 이상 끊겼다 돌아오면 "감시 공백" 메일을 한 번 보낸다.
- **메일을 보내지 못한 경우**: 알림을 상태 파일에 보관했다가 다음 주기에 순서대로 한 번씩 보낸다.
- **주기 신호**: 한 번 돌 때마다 Uptime Kuma의 Push 모니터에 "살아 있음"을 보낸다(대상이 장애여도 감시가 살아 있으면 보낸다. 메시지에 현재 판정을 적는다). 감시가 멈추면 Kuma가 그 침묵을 알린다. Kuma는 감시 대상 서버에 있으므로, **서버와 감시가 동시에 죽으면 알 수 없다.**

### 비밀값

- 설정은 `~/.config/gps-watch/config.ini`(빌드 호스트, 본인만 읽기 600)에 있다. 다른 계정이 읽을 수 있으면 감시가 실행을 거부한다.
- 메일은 STARTTLS(587) 또는 TLS(465)로만 보낸다. 암호화 없는 로그인은 시험용 로컬 서버 외에는 거부한다.
- 메일 비밀번호와 Push 주소는 출력·상태 파일·메일 어디에도 나타나지 않는다(리허설에서 확인).
- **에이전트는 비밀값을 받거나 입력하지 않는다.** 운영자가 `gps_watch.py secret …` 한 줄로 직접 넣는다(클립보드에서 곧바로 설정 파일로 가고 화면에 나오지 않는다). 비밀값은 명령줄 인자로 받지 않는다.

### 운영 서버에 남는 흔적

- nginx 접근 로그에 1분마다 사무실 주소의 `GET /health` 200과 `GET /ingest` 405가 한 줄씩 남는다. 수집 건수를 로그에서 셀 때 이 405는 단말기 보고가 아니다.
- SSH 로그에 1분마다 `Connection closed by … [preauth]` 한 줄이 남는다(감시가 식별 문자열을 보내고 끊으므로 오류 줄은 남지 않는다).
- **주의**: 운영 서버의 fail2ban은 설치만 돼 있고 꺼져 있다(2026-11-06 확인). 나중에 fail2ban을 공격적 모드로 켜면 이 접속이 차단 사유가 될 수 있고, 사무실 주소가 막히면 감시와 관리 접속이 함께 막힌다. 켤 때는 사무실 주소를 예외(`ignoreip`)에 넣거나 설정에서 `ssh =`를 비워 이 점검을 끈다.

## 절차

| 파일 | 실행 위치 | 하는 일 |
|---|---|---|
| `ops/gps_watch.py` | 빌드 호스트(일반 계정) | `run`(한 주기) · `check`(한 번 확인만, 상태·메일 없음) · `status` · `test-mail` · `set`(일반 설정값) · `secret`(비밀번호·Push 주소, 화면에 나오지 않음) |
| `ops/install_gps_watch.sh` | 빌드 호스트(일반 계정) | `files`(배치만) · `start`(타이머 시작) · `stop` · `remove` · `show` |
| `ops/gps-watch.service`, `ops/gps-watch.timer` | `~/.config/systemd/user/` | 매분 10초에 한 주기 |
| `ops/gps-watch.example.ini` | 설정 양식 | |
| `ops/rehearse_gps_watch.py` | 빌드 호스트 | 격리 리허설. 로컬 대역 서버만 쓰고 실제 메일을 보내지 않는다 |

## 격리 리허설 (2026-11-06, 커밋 `7356503`)

`127.0.0.1`에 운영 서버(health·수집 주소·상태 페이지·SSH 포트), 기준 주소, Kuma Push 주소, 메일 서버(STARTTLS·TLS·로그인)의 대역을 세우고 감시의 실제 코드를 돌렸다. 시계만 앞으로 돌려 한 시간을 기다리지 않는다. 9개 묶음 통과.

| 묶음 | 결과 |
|---|---|
| 정상 3주기 | 메일 없음, 주기 신호 3회 |
| 지연 1회, 연속 2회 실패, 반복되는 1회 실패 | 메일 없음 |
| 장애 전 과정 | 3번째 실패에 "장애 발생" 1통 → 1시간마다 "장애 지속" → 다른 점검 추가 실패에 "장애 변화" → 일부 회복에 "장애 변화" → 2회 연속 성공에 "복구" 1통(장애 시간 포함). 그 뒤 메일 없음 |
| 잘못된 응답 14종 | 오류 상태, DB 불가, 환경 불일치, API 대신 웹 화면, 무응답, 지연, SSH 배너 없음을 모두 실패로 판정 |
| 감시 위치 인터넷 끊김 10분 | 운영 서버 실패로 세지 않음, 돌아온 뒤 "감시 공백" 1통. 2분 끊김은 알리지 않음 |
| 메일 서버 장애 3종(접속 불가, 로그인 거부, 일시 거부) | 알림을 보관했다가 서버가 돌아오면 순서대로 한 번씩 발송. 중복 없음 |
| 전송 방식 | STARTTLS와 TLS에서 암호화·로그인 확인. 다른 호스트로의 비암호화 로그인과, 남이 읽을 수 있는 설정 파일은 거부 |
| 명령줄 | `run`·`status`·`check`·`test-mail` 동작. `check`는 상태를 남기지 않고 메일을 보내지 않음. 동시에 두 번 돌면 하나가 물러남. 비밀값 두 개는 파이프로 받아 보여 주지 않고 저장하며 명령줄 인자로는 거부. 비밀값이 출력·상태·메일에 없음 |
| 설치 스크립트(임시 홈) | 파일과 빈 설정(600)만 두고 아무것도 시작하지 않음. 설정이 비어 있으면 시작 거부. 채운 설정은 덮어쓰지 않음. 제거 시 설정·상태는 남김 |

기록: [rehearsal.json](evidence/infra-round2-20261106/rehearsal.json). 스크립트 SHA-256 `48ef88aa8b8816f2756542c7956cab4f627595b170fdf89d06ac5bd01ea1e3da`.

**리허설이 다루지 못한 것**: 실제 메일 서버(계정·인증 방식·발송 제한), 실제 Uptime Kuma의 Push 응답과 알림, 실제 타이머의 장기 가동, 실제 장애. 실제 메일은 `test-mail`로, 타이머와 주기 신호는 켠 뒤 확인한다. 운영 서버를 일부러 내려서 시험하지는 않는다.

## 실제 주소 읽기 전용 확인 (2026-11-06 17:11 KST)

빌드 호스트에서 `gps_watch.py check`(설정·상태·메일 없이 한 번 확인)를 실제 주소로 실행했다.

| 점검 | 결과 |
|---|---|
| `health` | 정상 — 릴리스 `pdf-service-20261106-r1`, 82ms |
| `ingest` | 정상 — API가 405(POST 전용)로 응답, 67ms |
| `ssh` | 정상 — SSH 응답, 41ms |
| `status` | 정상 — HTTP 302, 87ms |

운영 서버 SSH 로그에는 이 확인이 `Connection closed by … [preauth]` 한 줄로 남았다.

## 빌드 호스트 배치 (2026-11-06 17:11~17:17 KST, 에이전트 실행)

`install_gps_watch.sh files`로 **파일만** 두었다. sudo·패키지·시스템 파일 변경이 없고 타이머는 시작하지 않았다(`disabled`/`inactive`).

- `~/gps-watch/gps_watch.py`, `~/gps-watch/gps-watch.example.ini`
- `~/.config/gps-watch/config.ini` — 빈 양식, 600
- `~/.config/systemd/user/gps-watch.service`, `gps-watch.timer`
- 스테이징: `/home/etcom-hub/build/gps-watch-20261106`(설치 스크립트 포함)

이 호스트의 다른 사용자 서비스는 그대로다. 사용자 서비스는 로그인 없이 계속 돈다(linger 켜짐).

## 가동 (2026-11-06 17:22 KST)

- 운영자가 메일 계정을 지정했고 앱 비밀번호를 `secret password` 한 줄로 직접 넣었다(17:21 KST). 에이전트는 비밀번호를 보거나 입력하지 않았다.
- 운영자 요청으로 에이전트가 실행:
  - 17:22:12 KST `test-mail` — `smtp.gmail.com`이 메일을 받았다(`sent to …`, 종료 코드 0). 받은편지함에 `[GPS 감시] 시험 메일`이 왔는지는 운영자가 확인한다.
  - 17:22:21 KST `install_gps_watch.sh start` — 타이머 `enabled`/`active`, linger 켜짐.
- 첫 세 주기(17:23:14, 17:24:14, 17:25:14 KST): 네 점검 모두 정상(health 78~89ms, ingest 67~75ms, ssh 42~48ms, status 83~84ms), 사건 없음, 보낸 메일 없음, 서비스 결과 `success`.
- 운영 서버 쪽 확인(읽기 전용): 사무실 주소에서 분당 `GET /health` 200, `GET /ingest` 405, 상태 페이지 `GET /` 302가 한 번씩, SSH 로그에는 `Connection closed by … [preauth]`가 분당 한 줄. API 오류 0건, 실제 단말기 보고(`POST /ingest` 200)는 계속 들어온다.
- **주기 신호는 꺼져 있다**(`heartbeat_configured: false`). Push 주소가 들어오면 다음 주기부터 자동으로 보낸다. 다시 시작할 필요가 없다.
- 기록: [live-start.json](evidence/infra-round2-20261106/live-start.json)

## 켜는 순서 (운영자) — 2~4는 완료, 1과 Push 주소가 남음

1. **Uptime Kuma에 알림 수단 등록** (`status.serial.kr` 화면)
   - 설정(Settings) → 알림(Notifications) → 알림 설정(Setup Notification): 종류 **Email (SMTP)**, 아래 2번과 같은 메일 계정, 받는 주소 입력 → 테스트 → 저장. **기본 활성화**와 **기존 모니터 모두에 적용**을 켠다.
   - 새 모니터 추가(Add New Monitor): 종류 **Push**, 이름 예 `GPS 외부 감시(사무실)`, 하트비트 주기 **60초**, 재시도 **3**, 재시도 주기 **60초** → 저장. 화면에 나오는 **Push URL**을 복사한다(그대로 붙여 넣어도 된다. `?` 뒤는 감시가 무시한다).
2. **빌드 호스트의 설정에 비밀값 두 개 넣기** — 값은 화면에 나오지 않고 에이전트를 거치지 않는다.

   메일 앱 비밀번호를 클립보드에 복사한 상태에서(운영자 PC):

   ```bash
   powershell -NoProfile -Command "Get-Clipboard" | ssh etcom-hub-lan "python3 ~/gps-watch/gps_watch.py secret password"
   ```

   Kuma의 Push URL을 클립보드에 복사한 상태에서:

   ```bash
   powershell -NoProfile -Command "Get-Clipboard" | ssh etcom-hub-lan "python3 ~/gps-watch/gps_watch.py secret heartbeat"
   ```

   - 각각 `stored … (N characters; the value is not shown)`이 나온다. 구글 앱 비밀번호는 16자다(화면의 띄어쓰기는 자동으로 뺀다).
   - 직접 치려면 `ssh -t etcom-hub-lan "python3 ~/gps-watch/gps_watch.py secret password"` — 입력이 보이지 않는 프롬프트가 뜬다.
   - 비밀이 아닌 값(메일 서버, 계정 주소, 받는 주소)은 `gps_watch.py set mail.to 주소`처럼 바꾼다. 2026-11-06에 에이전트가 넣어 둔 값: `smtp.gmail.com` / 587 / STARTTLS(`serial.kr` 메일은 Google Workspace), 보내는 주소와 받는 주소는 운영자가 지정한 `serial.kr` 계정.
3. **시험 메일**

   ```bash
   ssh etcom-hub-lan "python3 ~/gps-watch/gps_watch.py test-mail"
   ```

   `[GPS 감시] 시험 메일`이 도착하는지 본다. 실패하면 `STOPPED:`로 사유가 나온다.
4. **타이머 시작**

   ```bash
   ssh etcom-hub-lan "bash ~/build/gps-watch-20261106/install_gps_watch.sh start"
   ```

5. 몇 분 뒤 확인: `ssh etcom-hub-lan "bash ~/build/gps-watch-20261106/install_gps_watch.sh show"` — 타이머의 다음 실행 시각, 최근 출력 줄, `heartbeat_ok: true`. Kuma의 Push 모니터가 초록색인지 본다.

끄려면 `install_gps_watch.sh stop`, 지우려면 `remove`(설정과 상태 파일은 남는다).

## 별도 항목으로 넘기는 관찰 (이번 라운드에서 바꾸지 않음)

- 운영 서버의 fail2ban은 설치돼 있으나 꺼져 있다. SSH는 비밀번호 로그인이 꺼져 있고 키만 허용하지만 `PermitRootLogin yes`이며, 인터넷에서 root 로그인 시도가 계속 들어온다(17분 동안 17건). 관리 접근·열린 포트 항목에서 다룬다.
- 감시 위치가 사무실 한 곳이다. 사무실 망·전원이 끊기면 감시도 멈추고, 그 침묵은 Kuma가 알린다(서버가 살아 있을 때).

## 남은 작업

- [x] 메일 계정 설정(운영자가 비밀번호 입력), 시험 메일 발송, 타이머 시작, 가동 확인(2026-11-06 17:22~17:25 KST).
- [ ] 운영자: 받은편지함에 시험 메일이 왔는지 확인(스팸함 포함).
- [ ] 운영자: Kuma 알림 등록과 Push 모니터 생성 → `secret heartbeat` 한 줄로 Push 주소 입력. 그 뒤 `status`의 `heartbeat_ok: true`와 Kuma 화면의 초록색을 확인.
- [ ] 첫 실제 장애·복구 메일이 오면 내용과 시각을 이 문서에 기록(운영 서버를 일부러 내리지 않는다).
- 그다음 기능 라운드: 권리 대응 17차(수집·이용·제공사실 열람).
- 별도 항목(섞지 않음): 방화벽 부팅 순서, 디스크 정리, 열린 포트·관리 접근, 회사 데이터 파기 정책.
