# SSH 출발지 제한 해제 증거

- `before.json`: 최초 점검, 사무실 전용22/IPv6 예외 없음, 비밀값 제외.
- `after-rollback.json`: 첫 검증 실패 후 SSH 원복 상태.
- `reconciliation.json`: 남은 차이가 UFW 사용자 체인의 기존5432 잔여 규칙 동기화뿐임을 원래 해시 재구성으로 확인.
- `applied.json`, `verified.json`: 최종 적용/새 SSH 연결 검증. 키/인증/Fail2ban·나머지 규칙·서비스 유지.
- `external-before.json`, `external-after.json`: 사무실 밖 별도 VPS의 TCP22 시간 초과→OpenSSH 배너 성공. `probe_source`는 해당 VPS의 내부 주소이며 실제 대상 서버가 본 주소는 아래 로그인 기록에 있다.
- `external-key-login.txt`: ProxyJump 경유 실제 `gps-dev` 키 로그인, 대상이 보고한 출발지115.68.178.125, 개발 소스 읽기 성공. 개인키 복사/에이전트 포워딩 없음.
- `SHA256SUMS`: 위 증거와 이 목록의 바이트 해시.

부사수 본인 PC/개인키 직접 시험, 외부 IPv6 실연결, 재부팅 검증은 하지 않았다. 실제 방화벽/SSH 출력이며 생성 UI가 아니다. [상세 기록](../../operations/ssh-access-20261118.md).
