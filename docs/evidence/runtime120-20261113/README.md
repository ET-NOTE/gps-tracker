# 120차 격리 검증 원본

2026-11-13, 빌드 호스트 `etcom-hub`에서 합성 계정·합성 영수증으로 실행했다. 운영 변경·실제 외부 통보·실결제는 없다. 화면 생성 이미지가 아닌 프로그램의 실제 검증 출력이다.

| 파일 | 내용 |
|---|---|
| `build-api.log`, `build-pdf.log` | 정본 입력의 fmt/clippy/test/release |
| `setup.json` | 초기 시험 환경 준비·자체 점검. 최종 처리기는 서비스 검사 전에 정본으로 교체·자체 점검 재실행했으며 최종 해시는 service-results와 후보 명세를 따름 |
| `service.log`, `service-results.json` | 전역 잠금·취소·13초 제한·강제 종료·재시작·권한 거부10검사 |
| `business.log`, `receipt-pdf-validation.json` | PDF 7시험군과 두 API·HTTP 취소 검사 |
| `api-lifetime-results.json` | API 둘의429, HTTP 취소0.013초, 복구 |
| `resources.json` | 정상 peak/OOM0과 의도적인 PDF 묶음 OOM1을 분리한 자원 원본 |
| `final-state.json` | 잔여 작업·임시 이미지·열린 거래 없는 종료 상태 |
| `cleanup.json` | 전용 컨테이너·망·slice 정리 확인 |
| `build-storage.json` | GPS 빌드 폴더·캐시 크기 읽기 전용 조사. 삭제 없음 |
| `candidate-manifest.json` | 소스/바이너리/후보 해시와 인수 경계 |
| `evidence-sha256.json` | 이 디렉터리 원본 파일의 해시 |

4GiB 전체 상한의 소량 PDF 검증이며 공유3GiB VPS 인수 결과가 아니다. 네이티브 운영 DB unit·정리·복원 전체 결합과 최신 월간 부하는 후속 검증이다. API 두 개의 정상 응답을 운영 API 증설 승인으로 해석하지 않는다.
