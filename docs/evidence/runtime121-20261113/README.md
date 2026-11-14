# 121차 네이티브 통합 검증 증빙

2026-11-13 빌드 호스트`etcom-hub`의 내부망·합성 자료에서 실행한 실제 출력이다. 운영자료·실제 이용자·외부 통보·결제·운영 변경은 없다. 화면을 생성한 이미지가 아니다.

| 파일 | 내용 |
|---|---|
| `cumulative.log`, `cumulative121.json` | 실제99→112,13단계 실패/재개, 원본13만행·623,000점, 암호화 중단/재개, 전체DB·파일복원 |
| `*nonsuperuser.log`, `missing-extension-rejected.log`, `resume-after-per-migration-interruptions.log` | 실제 마이그레이션 서비스 출력·예상된 권한 거부 |
| `regressions121.json`, `verify_runtime121.log`, `test_provision22*.log`, `round22*.json` | 정보주체 매핑·동의/철회·법인/외부제공 회귀3시험군 |
| `startup-settle121.jsonl` | 시작 직후 실제 집계 잠금이 해제될 때까지의 대기. HTTP 변경 재시도0·작업 비활성화 없음 |
| `test_privacy_receipt_pdf.log`, `receipt-pdf-validation.json` | 실제 암호화 원본을 처리한PDF7업무시험군 |
| `restore_runtime121.log`, `protected-restore121.json` | 오래된 암호화DB에 최신 권리체크포인트 재적용·유지보수 차단 유지·비소유자/다른 접속/모드 불일치 거부 |
| `mapping-history121.json`, `mapping-history-plan.json` | 합성32,000행·1,000개 깊이32교정이력의 조회 대조·실행계획 |
| `test_runtime121.log`, `runtime-faults121.json` | 네이티브8unit 보호 속성, 실제 파일정리·라이브러리 거부·3임시경로 소실/마스킹/복구 |
| `resources121.json` | 경로 장애 검사 종료 시 cgroup 관측. 시험 전체 최고치 또는 운영 용량 증거로 사용하지 않음 |
| `test_runtime120_service.log`, `pdf-lifetime121.json` | 동일120처리기로121환경에서 재실행한10수명검사·전역경쟁6건·잔여 처리기0 |
| `reboot121.json`, `reboot121-first.json`, `reboot-order121*.log`, `unit-order-verification.txt` | 시작 순서 순환 수정 후 연속2회 컨테이너의 빈`/run` 재부팅과 DB/API/보호정렬/PDF복구. 순서 검증 표준출력·오류가 없는빈txt도성공원본임. 실제 VPS 재부팅 증거는 아님 |
| `environment121.json`, `units/`, `mounts121.txt`, `*-credentials.json` | 실제환경·보호설정·읽기전용 자격증명 경계. 키·비밀번호·환경파일 내용 제외 |
| `final-state121.json`, `cleanup121.json`, `cleanup-verification.py` | 최종 평문위치/임시이미지/잔여작업/열린거래0, 시험자원 정리와정본소스380파일/필수이전산출물5개/기존컨테이너32개대조 |
| `candidate-manifest121.json` | 소스·의존120후보·바이너리·보호도구 파일 해시,운영 비활성 상태 |
| `development-*.log` | 개발 중 발견한 실패. 최종 통과 로그와 별도 보존 |
| `evidence-sha256.json` | 원본 파일바이트 대조용 해시 |

최종 소스`cce99a6`. `971409b`의 전체 흐름 재실행에서 누적·권리·복원·경로 장애까지 통과했고, 이어 PDF 검사 함수의`/proc` 종료 경쟁 보완`8b5b2ef`로PDF10검사를통과했다. 재부팅에서발견한시작순서순환을고친`cce99a6`로경로장애·작업복구·연속2회빈`/run`부팅·최종상태를다시확인했다. 전체4GiB·DB버퍼128MB·네이티브PG14.24/Timescale2.19.3, 단일API다. 공유3GiB 운영 서버 용량, 월간 지속부하, 외부키보관, 과거WAL/백업파기 인수는 아니다. root fixture와 제한된 root 전환 작업, postgres 복구 작업의 범위는 [121차 문서](../../operations/location-business-runtime121-20261113.md)를 따른다.
