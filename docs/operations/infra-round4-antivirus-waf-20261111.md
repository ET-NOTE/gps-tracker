# 인프라 4차 — GPS 범위 백신·웹 방화벽 설치와 실제 터미널

2026-11-11. **설치 및 상태 출력 완료 / 실무 인수 검증 보류.** 사용자가 전체 검사·호환 검증보다 계획서에 넣을 실제 터미널 출력을 우선하도록 지시했다. 출력은 실제 SSH 조회와 TLS 연결 결과이며 이미지 생성이나 성공값 대입을 사용하지 않았다. `114`는 작업 식별자이고 DB 스키마가 아니다.

## 최종 운영 상태

| 항목 | 실제 상태 | 경계 |
|---|---|---|
| UFW | active, 기본 수신 deny | SSH 사무실 IP만 허용. 다른 프로젝트 포트와 사무실 DB5432 예외 유지 |
| Fail2ban | active/running/enabled | 이전 라운드 sshd 보호 유지 |
| ModSecurity | `gps-modsecurity.service` active/running/enabled | **DetectionOnly**, 아직 차단 정책 인수 완료가 아님 |
| WAF 경로 | 기존 Nginx → 127.0.0.1:3045 → GPS API3040 | GPS API의 기존14개 upstream만 변경. 정적 웹·다른 프로젝트·구형3030은 범위 밖 |
| ClamAV | 1.5.4, 공식 서명28180 | 비상주 검사 방식. 실시간 상주 백신이라고 표현하지 않음 |
| 서명 업데이트 | `gps-antivirus-update.timer` active/waiting/enabled | 하루2회, 자원 제한 적용 |
| 자동 전체 검사 | `gps-antivirus-scan.timer` disabled | 실무 검증 이후 활성화. 진행 중이던 검사는 사용자 우선순위 변경에 따라 중단 |
| EICAR | 무해한 시험 파일 탐지 성공,15:54:48 KST | 전체 GPS 파일의 악성코드 없음 판정과 다름 |
| GPS 범위 검사 | incomplete | 전체 검사 성공·백신 인수 완료로 쓰지 않음 |
| 공개 HTTPS | Let's Encrypt / YE2, TLS1.3 및 강제TLS1.2 검증 성공 | 구형 HTTP 수집은 여전히 존재 |
| Cafe24 외부 방화벽 / 관리자 PC 백신 | 이번 작업에서 조작·확인하지 않음 | 별도 실제 화면 증빙 필요 |

운영 API 바이너리·웹 릴리스·스키마·펌웨어를 전환하지 않았다. 운영 API는 `privacy-log-20261107-r1`, 마지막 확인된 스키마99이며 후보112는 미배포다. Cafe24 대시보드에 이번 설치를 위한 새 포트를 열 필요는 없다. 별도 방화벽 활성화 절차는 [3차](infra-round3-security-20261111.md)를 따른다.

## ModSecurity 구성과 남은 호환 검증

호스트 Nginx1.18을 업그레이드하지 않고 OWASP 공식 컨테이너를 별도 루프백 프록시로 설치했다. 이미지 고정값은 `owasp/modsecurity-crs@sha256:b8d5bbf88c643800e31b248993858c335e4907ba0ee473d0c81c5726fb2c1bdc`이다. Nginx1.30.6·ModSecurity3.0.17·connector1.0.4·CRS4.30.0을 확인했다.

- localhost3045만 수신. 호스트 네트워크 사용은 기존 루프백 API 접근 목적이며 공개 포트 추가가 아니다.
- 비특권 사용자, 전체 capability 제거, no-new-privileges, 읽기 전용 루트,256MiB RAM/CPU0.5코어/64프로세스 제한.
- 요청 본문40MiB, CRS paranoia1, 응답 본문 검사는 꺼짐. 인증키·DB환경설정을 컨테이너에 전달하지 않음.
- 결정 로그는 시각·메서드·상태·처리시간만, 감사 로그는 AZ 부분만 저장한다. 파일은 하루회전/최대1MiB/7개 보관한다. 이는 진단 로그 정책이며 법정 취급대장 정책을 대체하지 않는다.
- 최초 차단 시험에서 원문 ModSecurity 진단이 systemd journal에 전달되는 것을 발견했다. `gps_waf_runner114.py`로 stdout/stderr를 제한 길이로 읽어 시각·분류·숫자 규칙ID·차단 여부만 남기도록 바꿨다. 과거 합성 시험 journal은 삭제하지 않았다. **수정 후 전체 로그 경로의 새 canary 재검증은 아직 남았다.**

처음 `On`으로 정상 health200, 합성 SQLi/XSS/경로탐색403, 정상 소형 JSON/form/multipart405(직접 API와 같음), 잘못된 인증401·WebSocket401을 확인했다.40회/동시4 health는 오류0, 공개 HTTPS p95 약76.8ms였다. 실제 단말 POST200도 이어졌다. 다만3MiB 사진 data URL JSON은 정상 POST405 대신403이 되어 오탐을 발견했다. 따라서 사용자 요청으로 실무 검증을 미루는 최종 상태에서는 **DetectionOnly로 변경하고 Nginx worker를 reload**했다. 이 상태를 공격 차단 완료라고 제출하지 않는다.

16:17 KST 캡처에서 WAF RAM44.52MiB/한도256MiB, CPU0.00%였다. 유휴 순간값이고 부하 중 최댓값은 아니다. 초기 준비 단계 재시작과 운영 적용 후 로그 필터 도입을 위한 WAF 재시작이 있었다. API·호스트 Nginx master는 재시작하지 않았다. WAF 재시작 순간의 upstream 오류 집계는 후속 검증으로 남긴다.

## 백신 구성·측정

공식 서명 전체 약362만개를 유지했다. 검사 범위를 줄이면 검사할 파일은 줄지만 서명 적재 메모리까지 그 비율로 줄지는 않는다. 실시간 daemon은 설치하지 않았다. 공식 freshclam 상주 unit은 중지·마스크하고 별도 제한된 oneshot 업데이트를 사용한다.

검사 범위는 GPS API bin, 현재 웹 dist-root, GPS uploads/private-uploads, GPS APK·ZIP downloads다.52개/497,576,678바이트였고 DB·백업·환경설정·다른 프로젝트는 제외했다. 파일 삭제·격리 없이 보고만 하며 검사 서비스 네트워크를 막았다.128MiB 파일/256MiB 확장량/압축4단계 등 한도를 초과하거나 읽지 못하는 항목은 건너뛰기·불완전으로 기록한다.

최종 제한은 aggregate 및 작업별 MemoryHigh625MiB/MemoryMax675MiB/SwapMax768MiB, CPU50%, Nice15, idle I/O,15분 제한이다. 호스트 MemAvailable300MiB 미만이면 검사만 중단한다. 스캔 임시 파일은 private tmp에 둔다. 디스크·swap 보호는 별도 과제다.

| 측정 | 시간 | 관측 peak cgroup RAM | 최소 호스트 가용 RAM | GPS health |
|---|---:|---:|---:|---|
| 최초 정상 서명 갱신 |42.21초|688.57MiB|389.63MiB|실패0, p95 4.661ms|
| EICAR 성공 |572.55초 모니터링|699.96MiB|360.59MiB|실패0, p95 2.955ms|
| 최종 GPS 검사, 사용자 지시에 따라 중단 |583.45초|674.93MiB|355.75MiB|실패0, p95 3.048ms|

EICAR 성공 중 제한값을 조정했으므로 최종625/675MiB 설정에서 동일 성공을 검증한 것은 아니다. 초기 AppArmor 경로·DB 읽기 권한·임시 폴더 권한 오류를 고쳤으며, 앞선 전체 검사는 메모리 보호 기준으로 중단됐다. 최종 검사 역시 성공이 아니며 systemd signal15 기록이 남아 있다. 기존 기록을 지우거나 clear로 바꾸지 않았다. 순수 검사 CPU와 swap I/O 때문에 실제 소요 시간이 길었으므로 **이3GB VPS에서 가벼운 정기 검사 운영이 충분히 검증됐다고 결론 내리지 않는다.**

## 재개 순서 / 증빙

1. 큰 사진 JSON 오탐의 규칙 원인을 합성 전용 진단 로그로 확인하고, 최소 범위 예외와 사진·multipart·서명수집·실시간 경로를 검증한다. 정상 요청 인수 후 차단 On을 별도로 적용한다.
2. 로그 필터 이후 새 canary가 WAF·systemd·호스트 오류 분류기 어디에도 원문으로 남지 않는지 확인한다. WAF 중단·복구/502 및 부팅도 검증한다.
3. 최종 자원 한도에서 EICAR와 GPS 전체 범위 검사를 완료하고 swap/I/O 및 다른 서비스 영향을 측정한다. 통과 전 daily timer를 켜지 않는다. `finalize_antivirus114.py enable`은 EICAR 성공·clear_within_scope를 요구한다.
4. 서명 갱신 실패·검사 중단의 외부 경보 연결과 실제 정기 실행 확인. EICAR 한 번 성공으로 대체하지 않는다.

원격 상세 기록: `/var/lib/gps-antivirus-install114`, `/var/log/gps-antivirus`, `/var/lib/gps-waf-install114`. 원본 사용자 파일명/요청 진단은 외부로 복사하지 않는다. WAF route 복구는 `install_waf114.py rollback`이 변경 후 해시를 확인한 뒤 원래 GPS upstream만 복원한다. 설정이 추가 변경되면 중단하므로 덮어쓰지 않는다.

실제 터미널 재실행: `ops/show_security_terminal114.ps1`. SSH키가 설정된 PC에서 실행한다. [수정하지 않은 실제 터미널 캡처](../evidence/security114-20261111/actual-security-terminal.png), [출력 원문](../evidence/security114-20261111/terminal-output.txt), 상태·TLS JSON을 함께 보관했다. 공개TLS 증빙은 단말→서버 전량 TLS 또는 DB 암호화를 증명하지 않는다.
