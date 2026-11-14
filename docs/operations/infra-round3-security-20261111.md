# 인프라 3차 — 실제 보안 점검·SSH 제한·Cafe24 방화벽 준비

2026-11-11 KST. 대상은 `210.114.18.16` 공유 VPS다. 사용자 요청으로 실제 상태를 점검하고, 사용자가 고정 주소로 확인한 `221.159.164.177`을 SSH 허용 IP로 적용했다. **앱·DB 스키마 배포 라운드가 아니다. `security113`은 작업 파일 식별자이며 스키마113을 뜻하지 않는다.** 최신 개발 후보는112, 운영 API는 `privacy-log-20261107-r1` 그대로다.

## 결과

| 항목 | 확인/적용 결과 | 남은 범위 |
|---|---|---|
| OS 방화벽 | UFW active, 기본 inbound DROP / outbound ACCEPT. IPv4 INPUT의 누락된 UFW 연결 규칙 복원 | 다른 프로젝트의 기존 서비스 포트는 유지. 최소 공개 포트로 축소 완료 아님 |
| SSH | 모든 IP 허용을 제거하고 **221.159.164.177/32만 허용**, IPv6 SSH 허용 제거. 새 SSH 연결 성공 | 사무실 개발 회선이다. 미래의 별도 관리자 PC·회선 제한 완료 아님 |
| 부팅 순서 | `ufw.service`가 `netfilter-persistent.service` 뒤에 실행되도록 설정 | **실제 재부팅 검증 전**. 이번에 VPS 재부팅 안 함 |
| Fail2ban | 기존 설치0.11.2-6을 enabled/active로 전환. sshd 10분 내5회 실패→1시간 차단 | IP 단위 SSH 차단. 앱 계정 잠금·MFA 기능을 대신하지 않음 |
| 공개 인증서/TLS | Let's Encrypt / YE2. 공개443에서 기본TLS1.3·강제TLS1.2, 체인·호스트명 검증 성공 | 실물 단말기 전체의 TLS 전환을 증명하지 않음 |
| ClamAV | **미설치**, daemon/freshclam unit not-found | VPS 총RAM2967MiB·여유약1GiB. 메모리 증설/서버 분리 후 적용 |
| ModSecurity | **미설치/미적용**, nginx에 로드된 모듈·활성 지시어 없음 | 현재Nginx와 호환되는 설치·탐지 모드·차단 회귀 검증 필요 |
| Cafe24 외부 방화벽 | 사용자 첨부 화면은 **OFF**. 이번에는 콘솔 설정 변경하지 않음 | 공유 서비스 포트·OUTBOUND·복구 경로를 확인한 뒤 켜야 함 |
| DB 외부 경계 | PostgreSQL5432가0.0.0.0/[::]에서 듣고 있음. OS 방화벽은 루프백·사무실IP만 허용 | **서버 내부 전용 아님**. 사무실 직결을 SSH터널로 전환 후 예외 제거 필요 |

11월6일 VPS 장애는 사용자 확인에 따라 **호스팅 업체 긴급 업데이트 문제**로 유지한다. 이번에 고친 UFW 부팅 순서 위험을 그 장애 원인으로 다시 단정하지 않는다.

## 적용과 검증

1. root 전용 `/var/lib/gps-security113-20261111`에 기존 IPv4/IPv6 filter 및 UFW 사용자 규칙을 보관했다. 준비 중 누락된 IPv4 `reject`·`track` 체인을 발견해 생성 계획을 보완했다. 최초 불완전 준비 기록은 `…-incomplete`로 보존했다.
2. 14:57:18 별도 network namespace에서 변경·검증·복구를 통과했다. IPv4/IPv6 filter table만 다루며 NAT/raw 및 Docker 전달 규칙은 보존한다.
3. 14:58:16 운영 적용. 180초 자동 복구 타이머를 먼저 등록한 뒤 filter를 원자적으로 교체했다. 방화벽을 끄거나 전체 허용 상태로 만들지 않았다.
4. 14:58:23 연결 공유를 사용하지 않는 **새 SSH 세션**에서 사무실 출발IP를 확인하고 타이머를 취소했다. 현재 타이머는 inactive/not-found다.
5. Fail2ban 최초 시작 시 서비스 시작과 소켓 준비 사이의 지연 때문에 확인이 먼저 실패했다. 자동으로 disabled/중지·설정 제거가 수행된 것을 확인했다. 최대20초 준비 대기를 추가한 뒤 14:59:47 정상 가동했다.
6. 필터 시험에서 기본 `publickey=nofail`은 공개키 인증 실패를 실패 횟수로 세지 않는 것을 발견했다. 키 인증만 사용하는 서버에 맞게 `sshd[mode=normal, publickey=any]`를 적용했다. localhost와 사무실IP는 차단 대상에서 제외한다.
7. 합성 SSH 실패 로그5줄이 모두 매칭되는 것을 확인했다. 문서용 예약주소 `192.0.2.123`을 실제 Fail2ban으로 차단·해제하고 커널 규칙 생성/제거를 확인했다. **실제 계정에 잘못된 로그인을 시도하거나 외부로 공격 트래픽을 보내지 않았다.** 총 차단 통계에는 이 수동 검증 횟수가 포함된다.
8. 두 개의 격리 network namespace 사이에서 실제 TCP11건을 검증했다. 사무실 출발주소SSH허용/다른주소DROP, IPv6SSH DROP, HTTP/HTTPS허용, 기존DB 사무실예외허용/다른주소DROP을 확인했다. **이는 운영 규칙 복제 환경의 패킷 검증이며 외부 제3회선 실측은 아니다.**
9. 기존 `check_firewall_layout.sh`9항목 통과. UFW·Fail2ban systemd 설정 검사 통과. 검사 중 기존 snapd의 알 수 없는 RestartMode와 dev API unit 실행권한 경고가 있었으며 이 작업에서 변경하지 않았다.
10. 전후 NAT/raw 해시, GPSAPI·ShieldAPI·Nginx·PostgreSQL 상위unit·Docker·Mosquitto의 PID/시작시각/재시작횟수 동일. GPS health(DB포함)정상, GPS·Shield HTTPS접근 성공, status서비스302 응답. Shield의 기존 NRestarts237은 전후 동일하며 이번 작업의 재시작이 아니다.

`sshd -T`는 `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `PermitRootLogin yes`, `MaxAuthTries 6`이다. **비밀번호 로그인 차단은 확인했지만 root 로그인 자체가 금지된 것은 아니다.** SSH키 사용을 앱 2차 인증 완료로 기록하지 않는다.

## 실제 수집 포트와 이미지 내용의 수정

- `gps.serial.kr:443/ingest`는 Nginx를 통해 루프백3040의 GPS API로 전달된다. 운영용 HTTPS 수집에 별도 포트를 추가할 필요가 없다.
- **80번은 HTTPS리디렉션·인증서갱신만이 아니다.** GPS/seriallog의 구형 HTTP수집과 Shield교육용 HTTP경로가 남아 있다. 전체 단말 TLS전환 완료 전 임의로 막으면 수집이 끊긴다.
- `idf_caltest/main/config.h`의 정상HTTPS분기는443이고, `GPS_TLS_CERT_TEST`의18443은 인증서 거부시험 전용이다. 현재호스트에18443리스너가 없으며 운영방화벽 허용표에 넣지 않는다.
- 실제 DBMS는 PostgreSQL이고 포트는 **5432**다. 이미지의3306은 이 서버의 DB포트가 아니다.
- UFW/네트워크 방화벽은 IP·포트 기반이다. SQL주입·XSS 본문 검사를 수행하는 WAF와 동일하지 않다. Fail2ban도 WAF가 아니다.

## Cafe24에서 사용자가 할 작업

### 적용 전

1. 현재 규칙을 캡처·내보내고 **웹 콘솔/복구 접속이 실제로 가능한지** 확인한다. SSH키 전용 환경이므로 웹 콘솔의 비밀번호 로그인이 자동으로 가능하다고 가정하지 않는다.
2. 아래 공유 포트 표를 다른 프로젝트 운영자와 확인한다. Cafe24 방화벽은 `gps.serial.kr`만이 아니라 **VPS 전체IP**에 적용된다.
3. 이미지의 OUTBOUND `ANY(DROP)`을 그대로 두고 켜지 않는다. 이번 정책은 **OUTBOUND 전체허용(ANY/ALLOW)**이다. DNS·시간동기화·메일·FCM·업데이트·인증서갱신·응답패킷이 통과해야 한다.
4. 아래 규칙을 미리 저장할 수 있는지 확인한다. 공식 안내는 ON 후 규칙 설정 순서이므로, 현재 화면이 사전등록을 지원하지 않으면 지원팀과 초기 적용/복구 순서를 확인하고 점검 시간에 진행한다. **규칙 없는 기본DROP 상태로 먼저ON하지 않는다.**

### 핵심 허용표

| 방향 | 프로토콜/포트 | 허용IP | 설명 |
|---|---|---|---|
| INBOUND | TCP443 | ANY | GPS·Shield 및 같은 VPS의 웹/API·HTTPS 수집 |
| INBOUND | TCP80 | ANY | ACME·리디렉션·아직 남은 HTTP 단말 수집 |
| INBOUND | TCP22 | **221.159.164.177/32** | 사용자 확인된 사무실 고정 공인 IP. 별도 관리자 회선 도입 시 새 IP 추가·연결 검증 후 이전 IP 제거 |
| INBOUND | TCP5432 | 공개 허용 금지 | 목표는 허용 규칙 없음. 현재 사무실 DB 직결을 쓰는 작업은 SSH 터널로 전환해야 함 |
| INBOUND | 나머지 | 기본 DROP | 아래 공유 서비스 예외는 용도 확인 후 반영 |
| OUTBOUND | ANY | ANY | 전체 허용 유지 |

카페24의 ‘특정 IP 허용’은 포트22에 한정한다. 사무실 IP에 대해 모든 포트를 허용하는 규칙으로 바꾸지 않는다. 이 표는 호스트가 이미 허용한22/80/443 정책과 맞추는 외부 방화벽 설정이다.

### 같은VPS의 추가 포트 — 22/80/443만 열면 영향 있음

| 현재상태 | 포트 | 확인된서비스/조치 |
|---|---|---|
| TCP리스너있음 | 1883,1884,8883 | Mosquitto·Nginxstream MQTT. **8883이라는번호만으로TLS라단정하지않음** |
| TCP리스너있음 | 1935,8001,18080 | Docker매핑 영상/중계서비스 |
| TCP리스너있음 | 3010 | 별도Node서비스 |
| TCP리스너있음 | 5175,5177,5180,8443 | Nginx 별도프로젝트/개발서비스 |
| TCP리스너있음 | 8070 | 별도펌웨어배포 HTTP |
| 기존OS허용, 이번리스너없음 | TCP8080,8081,8554,8889,9996 / UDP8000,8001,8189 | 과거영상/개발용허용. 즉시미사용으로단정하지말고용도확인후삭제 |

기존 서비스를 유지하는 임시 전환이라면 필요한 추가 포트도 등록한다. 용도를 확인하지 못한 상태에서는 **Cafe24를 아직 OFF로 유지**하고 확인부터 마친다. 영구적으로 모든 기존 포트를 열자는 제안이 아니다. Docker 공개 포트는 호스트 INPUT/UFW만으로 제어되지 않는 경로도 있으므로 외부 방화벽·DOCKER-USER 경계를 함께 검토한다.

### 적용 직후 확인·캡처

- 새 SSH 연결, `https://gps.serial.kr/health`의 ok/db, Shield 로그인 페이지·연동 중인 공유 서비스를 확인한다.
- 실제 단말기의 다음 보고가 도착하는지, 외부 감시·Kuma의 주기 신호가 유지되는지 확인한다.
- 허용되지 않은 별도 외부 회선에서 SSH가 차단되는지 확인한다. 이번 격리 시험과 구분해 증빙한다.
- 대시보드 ON·인바운드 IP/포트·OUTBOUND 허용이 함께 보이게 캡처한다.
- 문제 시 복구 접속으로 규칙을 수정한다. **OFF를 누르면 규칙이 모두 초기화**되므로 저장한 목록으로 복구해야 한다. OFF가 단순한 일시중지라고 안내하지 않는다.

근거: [Cafe24 가상서버 방화벽 공식 안내](https://help.cafe24.com/faq/server-hosting/virtual-server-hosting/etc/vps_firewall_myservice_setup/), 2026-11-11확인.

## 미설치 항목 후속 작업

### 백신

현재 총 RAM은2967MiB이고 약1GiB가 가용하다. [ClamAV 공식 요구사항](https://docs.clamav.net/Introduction.html#recommended-system-requirements)은 표준 서명 DB에 RAM3GiB 이상·여유 디스크5GiB를 권장하며 다른 앱이 없는 시험 기준이다. 이 공유 VPS에 상주 엔진을 바로 추가하면 GPS/DB와 메모리를 경합한다.

- 사용자는 Cafe24에서 **RAM 증설 가능 여부 또는 GPS 전용 서버 분리**를 확인한다. 공유 구성을 유지한다면 기존 실사용량+백신+여유를 합친6~8GiB급을 용량 검토 출발점으로 삼되, 특정 상품의 제공/성능을 보장하는 값은 아니다.
- 자원 확보 후 ClamAV/서명 업데이트 설치 → 업데이트 성공 → 표준 무해 시험 문자열 탐지 → 주기 검사·격리 권한·보고·메모리 상한 검증 → 실제 서비스 상태 캡처 순으로 진행한다.
- DB 실파일/백업을 자동 삭제하지 않고 격리/보고 정책을 먼저 정한다. ClamAV daemon이 켜진 것만으로 실시간 파일 접근 차단이 완료된 것으로 기록하지 않는다.
- 관리자 PC 백신은 별도 PC 준비 후 실제 설치·업데이트 상태를 캡처한다. 이 서버 점검으로 PC V3 설치를 입증하지 않는다.

### 웹방화벽

현재 Nginx1.18.0(Ubuntu22.04 패키지)에 ModSecurity가 로드되지 않았고 사용 중인 저장소의 호환 모듈 후보도 확인되지 않았다. 공유 Nginx에 검증되지 않은 바이너리를 즉시 추가하지 않았다.

1. 별도 프록시/호환 모듈 또는 실제로 계약 가능한 관리형 WAF를 선택한다. Cafe24 VPS의 기본 네트워크 방화벽을 WAF 상품으로 표기하지 않는다.
2. 격리 환경에서 정상 로그인·서명 수집·대용량 업로드·다운로드·WebSocket 및 악성 표본 차단을 시험한다.
3. GPS 호스트만 탐지 모드로 관찰한 후 차단으로 전환한다. 로그에는 위치 본문·인증키·쿠키·토큰을 남기지 않도록 기존18A 로그 보호 정책과 맞춘다.
4. 정상 요청 오탐·다른 프로젝트 영향·메모리/CPU를 확인한 후 실제 정책/차단 로그를 캡처한다.

## 증빙과 재실행

- [실제 터미널 캡처](../evidence/security113-20261111/actual-terminal-security.png): Windows PowerShell에새SSH실측과외부TLS검증을표시한창의원본픽셀. 생성이미지아님. 일부명령결과를읽기쉽게발췌하며 전체원본JSON도보존한다.
- [변경전](../evidence/security113-20261111/before.json), [변경후](../evidence/security113-20261111/after.json), [변경시각·검사](../evidence/security113-20261111/state-changes.json).
- [격리TCP11건](../evidence/security113-20261111/network-rehearsal.json), [Fail2ban필터·차단/해제](../evidence/security113-20261111/fail2ban-test.json).
- [터미널원문](../evidence/security113-20261111/terminal-output.txt), [공개TLS실측](../evidence/security113-20261111/live-tls.json).

로컬 `ops/show_security_terminal113.ps1`은 실제 서버를 읽기 전용 조회하고 터미널을 열어둔다. 별칭 `seriallog`와 SSH키가 준비된 PC에서 사용한다. 원격 inventory 파일은 `/home/mmm/gps-artifacts/security_inventory113.py`다. `enable_fail2ban113.py`/`security_host113.py apply`는 이미 완료한 변경을 중복 실행하지 않도록 검사한다.

복구가 필요하면 원인 확인 후 Fail2ban을 먼저 중지하고 root 전용 백업으로 filter/UFW 파일을 복구한다. 백업은 변경 시점의 상태이므로 추가 서비스 규칙이 바뀐 후 그대로 덮어쓰면 안 된다. 이전 상태에는 SSH 전체 허용과 UFW 누락이 있으므로 긴급 복구 뒤 이 문제를 다시 해결해야 한다.

**남은 우선순위:** 공유 포트 정리·DB 직결 제거 → Cafe24 외부 방화벽 ON/외부 회선 검증 → RAM 확보·백신/WAF → 계획된 재부팅 검증. 별도 관리자 회선/PC, 실제 단말 TLS 전환, 후보100~112의 정책/암호화 운영 활성화는 계속 열린 항목이다.
