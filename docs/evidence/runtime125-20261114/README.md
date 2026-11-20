# 125차 실제 전환·복구 검증 자료

2026-11-14 빌드 호스트`etcom-hub`의 합성 격리 시험 원본80개다. 운영에 접속하거나 실제 이용자 데이터를 사용한 결과가 아니다. 이전121 검증기를113 후보에 맞춘 어댑터로 재실행했으므로 파일명에121/122/124가 남아 있는 자료도 **이번125 실행 결과**다.

## 증거를 읽는 순서

| 자료 | 확인할 내용 |
|---|---|
| `commands.jsonl`, 시각이 붙은`.log` | 실제 UTC 시작 시각·시간·명령·종료 코드·빌드 여유. 누적 실패2회, 최종 성공, 후속 검사와 프록스 준비 실패/재검증 |
| `cumulative121.json` | 실제99→113의14단계 실패·원복·재개, 제한된 소유자,13만행/623,000점·파일3개 암호화와 전체 복원 |
| `failed-attempt1/`, `failed-attempt2/` |113 미지원 도구로 중단된 결과, 전체 복원은 통과했지만 월간 API408로 중단된 결과 |
| `migration-bytes.json`, `adapters/` | 기존 SQLx 체크섬을 유지한113개 SQL, 생성된 검증 어댑터·원본/생성본 해시 |
| `direct99-to113-nonsuperuser.log`, `missing-extension-rejected.log`, `resume102-to113-nonsuperuser.log` | 비슈퍼유저 전환, pgcrypto 권한 부족 때 거부, 별도 관리자의 준비 뒤 재개 |
| `schema-tools125.json` | 네 정비 도구113 검사, 암호문 불변, 미래114 모두 거부 |
| `restored-api125.json`, `final-state125.json` | 복원 DB 일간3조회와 원본 DB 재기동 후 HTTPS3조회의 응답 바이트 동일·타 계정404·평문/임시/열린거래0 |
| `dense-month125.json` | 원본 시험 DB 재기동 뒤 월간200·6.093초. **복원 직후408을 해소한 증거가 아님** |
| `round22*.json`, `test_provision22*.log`, `regressions121.json` | 동의·철회·중지·매핑·SIM·제공 경계20업무 시험군. 외부 FCM 발송0 |
| `protected-restore121.json` | 오래된 전체 백업 위에 최신 권리 체크포인트 적용, 동의·삭제 부활 방지, 재전송 거부. 외부 키/체크포인트 보관은 미검증 |
| `mapping-history121.json`, `mapping-history-plan.json` |32,000행 계보 조회와 실제 실행계획 |
| `receipt-pdf-validation.json`, `test_privacy_receipt_pdf.log`, `pdf-lifetime125.json` | PDF7업무 시험군·10수명 검사·실제 픽셀·취소·프로세스 종료·격리 |
| `runtime-faults121.json`, `units/`, `mounts125.txt`, `*-protection.json` | 실제 서비스 설정·3종 마운트 장애·자격증명 읽기 전용·작업 계정 분리 |
| `reboot125-1.json`, `reboot125-2.json`, `reboot-order125-*.log`, `unit-order-verification.txt` | 빈`/run`으로2회 재기동. 순환 의존·오류가 없어 verification stdout은0바이트 |
| `fairness124.json`, `cancellation122.json` | 실제 HTTPS 이력1/전체2·취소·429·Retry-After·자리 회수. 재사용된 route 이름은month이지만125에서는일간범위로 치환 |
| `environment125.json`, `running-source125.json`, `candidate-manifest125.json` | 실제2CPU/4GiB 격리·실행 코드·API·복구 묶음 해시, activation_ready=false |
| `cache-cleanup125.json`, `host-before.json`, `host-after.json` | 재생성 가능한 컴파일 캐시만 정리.847개 보존 파일·다른32개 컨테이너 유지, 시험 자원 제거 |
| `remote-byte-check.json`, `sha256.json` | 원격80개 원본의 바이트 대조·로컬 최종 파일 해시 |

## 해석과 재현 범위

최종 누적 실행은13:17:14~13:20:56 KST, 후속 검사는13:24:47까지, 시험 자원 정리는13:25:35다. API는124의`89293eb52d7c07229e7fdfa594a63aa61282abe14ed1bf5d0a66d21fb3e15bc8`를 그대로 사용한다. 도구 최종 정본`bad2eff`, PDF는120 바이너리다. 초기 누적/권리/복원은`f22a3d1`, 마지막 HTTPS는 프록스 준비 대기를 고친`bad2eff`로 실행했다. 후자의 변경은 복원 함수·API·SQL을 바꾸지 않는다.

14개 마이그레이션은 각 트랜잭션 실패와 재개를 실제로 실행했다. 스키마113은 함수만 바꾸므로 함수 정의 지문까지 원복을 확인한다. 전체 원본/파일 해시는 전량 비교했고, 실제 복원 API 확인은일간 집계·이력·페이지다. 고밀도 **월간** 집계의 복원 직후408과 원본 DB 재기동 후200은 서로 다른 DB 상태다. 원인과 안정적인 성능 인수는 열려 있다. 성공 로그만 추려서 실패를 숨기지 않는다.

격리 네이티브 PostgreSQL14/Timescale2.19.3,2CPU/4GiB·DB shared_buffers128MB·보호 tmpfs·swap0/core0이다.124의8MiB/s/200IOPS 공유 부하나 현재3GB 운영VPS의 용량 인수 자료가 아니다. 조회 TLS는 자체서명localhost 인증서를 검증한TLS1.2이며 공개 인증서·실물 LTE를 증명하지 않는다. 복원 DB 첫 조회는 내부 loopback HTTP로, 이후 HTTPS 검사와 구분한다.

키·자격증명·DB 덤프·실제 이용자 좌표·원본 응답 본문은 넣지 않았다. 보호받는 코드가 참조하는 파일 경로와 합성 식별자·해시·통계만 보존한다. 암호화 전환 제어기의 제한된root와 복원postgres를 일반 API 비특권 계정과 혼동하지 않는다. 원본 파일에는Git 줄바꿈 변환을 하지 않는다.

재현 순서: 고정 의존성 준비 → `setup` → `runtime121_cumulative.py` → `test_schema125_tools.py` → `verify_runtime121.py` → `restore_runtime121.py` → `test_runtime121.py` → `pdf` → `reboot` → `verify_runtime125_reads.py` → `collect_runtime125.py collect/package` → `cleanup`. `ops/rehearse_runtime125.py`로 각 단계를 실행하며 운영 DSN은 받지 않는다. 기존 실행 폴더를 덮어쓰기하지 않고 초기 guard와 고정 자원 범위를 확인한다. 의존 묶음·정확한 해시·남은 항목은 [작업 문서](../../operations/location-business-runtime125-20261114.md)를 따른다.
