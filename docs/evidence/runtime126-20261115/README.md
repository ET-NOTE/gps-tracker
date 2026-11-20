# 126차 실제 격리 검증 증거

2026-11-15. **복원 직후 통계 누락 보완 검증 완료 / 동시 부하 성능 미달 / 운영 미배포.**
2CPU·4GiB·PostgreSQL14/Timescale2.19.3·정렬tmpfs256MiB의 합성 시험이다. 운영 VPS 접속·외부 발송·실제 이용자 데이터 사용은 없다.

원격 원본109개를 바이트 그대로 보존했다. 이후 시험 자원 정리 결과1개도 별도 원격 SHA-256과 대조했다. [원격 파일별 크기·해시](remote-byte-check.json), [정리 후 바이트 확인](post-cleanup-byte-check.json), [최종 파일 해시](sha256.json)를 제공한다. `.gitattributes`로 Windows에서도 원본 줄바꿈을 보존한다. 실제 무작위 키·런타임 비밀번호가 원본 파일에 포함되지 않았는지 반출 전에 검사했다. 덤프·키·자격증명·좌표 응답 본문은 포함하지 않는다.

| 확인 항목 | 원본 증거 | 해석 |
|---|---|---|
| 실행 순서·성공·실패 | [명령 기록](commands.jsonl) 및 시각별 `.log` | 종료0인 부하 수집 작업도 성능 합격을 뜻하지 않음 |
| 99→113·암호화·전체 복원 | [누적 결과](cumulative121.json), [마이그레이션 바이트](migration-bytes.json), [생성 어댑터](adapters/runtime121_cumulative.py) | 125의 실제 절차 재사용,13만 행·623,000원시점·파일3개 해시 대조 |
| 자동 통계 전후 | [처음 성공](initial-baseline126.json), [즉시 복원408→200](automatic-baseline126.json), [초기 통계](stats126-fresh.json), [자동 분석 후](initial-stats126-after-baseline.json) | 다른 DB의 성공으로 실패를 대체하지 않음 |
| 통계 미수집 대조군 | [두 번408](controlled-baseline126.json), [JIT ON 진단60초 실패](profile126-controlled-default.json), [JIT OFF 진단60초 실패](profile126-controlled-jit-off.json), [계획](profile126-controlled-plan.json) | 실제 API20초 유지, 캐시/JIT만으로 해결 안 됨 |
| 통계 보완 효과 | [통계 갱신·행 해시](analyze-experiment126.json), [수정 후200](after-analyze-api126.json), [실행계획](profile126-after-analyze-default.json) | 통계0.186초, 같은13만 암호화 행 불변, 집계약6초 |
| 새 복원 반복 | [3회9응답](fresh-restores126.json), [자동 통계 설정 복구](autovacuum-control-restored126.json) | 첫 월간 집계/이력/페이지200 및 응답 해시 동일 |
| 실패 차단·권한 | [7검사·비슈퍼유저 정비](statistics-guards126.json), [서비스 보호](transition-protection126.json) | 다른 접속·런타임·114·차단 없는 실행 거부, 중단 시 차단 유지 |
| 실제 복제본 기동 대기 | [기동 관측](startup-settle121.jsonl), [3초 잠금 시험](statistics-guards126.json) | 복제본을 원본 DB로 잘못 관측하던 시험기 수정, 실제 대기4.082초 |
| 압축 후 단일 조회 실패 | [API 오류 로그](restart-failure126.log), [재조회](restart-retry126.json), [전체 통계로도 미해결](compressed-full-db-analyze126.json) |3청크 압축 후 월간 이력500/임시공간 부족. 정렬 한도 증가로 숨기지 않음 |
| 압축 후 지속 부하 | [301.165초·3작업자](sustained126-compressed.json) |200 241·500 652·429 16. **성능 미달** |
| 압축 전 지속 부하 | [306.191초·3작업자](sustained126-uncompressed.json), [대조 조건](uncompressed-control126.json) |200 170·500 111·429 52. **동시 집계도 성능 미달** |
| DB 재시작·실제 TLS | [압축 전3경로](restarted-db126-uncompressed.json), [압축 후](restarted-db126-compressed.json) |검증한 합성localhost TLS1.2. OS 캐시는 비우지 않음 |
| 권리/SIM/통보·PDF | [4개 실행기](regressions121.json), [22](round22-encrypted-integration.json), [22B](round22b-encrypted.json), [22D](round22d-encrypted.json), [PDF](receipt-pdf-validation.json) |20업무 시험군·7개 PDF 업무 검사 통과 |
| 취소·429·자리 반환 | [이력 공정성](fairness124.json), [집계/페이지](cancellation122.json) |일간 범위의 실제TLS 잠금/취소 검사. 월간 부하 합격과 구분 |
| 최종 데이터 보호 | [두 DB 상태](final-state126.json) |후보113, 평문/임시이미지/정리대기/열린거래0, 타 계정404 |
| 실행 환경 | [환경](environment126.json), [마운트](mounts126.txt), `units/`, [API 전체 로그](gps121-api126.log), [DB 로그](gps121-db126.log) |호스트bind0·공개port0·내부망. 중첩systemd 시험 권한을 운영에 복사 금지 |
| 소스·묶음 | [실행 소스](running-source126.json), [줄바꿈 대조](source-normalization126.json), [최종 후보 묶음](candidate-manifest126-r2.json) |소스689a74c·API124 재사용·스키마113·activation_ready=false |
| 정리·이전 자료 보존 | [전](host-before.json), [후](host-after.json) |851기존 파일 해시·다른32컨테이너 동일, 시험DB/키/컨테이너/망 제거 |

압축 전후 부하는 모두 같은 월간 범위·20초 제한·3작업자·2실행 상한·2초 간격 최대2회 재시도를 썼다. 성공한 응답 해시는 모두 기준과 같고 새OOM·swap·잔여 조회는0이다. 성공한 요청만 골라 성능 합격으로 표현하지 않는다. 높은500 때문에 운영 전환은 보류한다. 압축을 멈춘 대조는 격리 복제본에만 적용했으며 운영 정책 제안이 아니다.

실패도 유지한다. 첫 실행계획 수집은 psycopg 확장 프로토콜의 `EXECUTE` 인수 타입 오류였고, 안전한 `ClientCursor` 리터럴 적응으로 수정했다. 첫 정비 로그인 시험은 역할 분리 후 소유자 멤버십이 없어 거부됐고, 시험용 정비 로그인에만 올바른 권한을 부여했다. 재시작 후500 두 회와 전체 열 통계 실험 실패는 제품/성능 실패로 남긴다. 전체 열 통계 실험의 소스는 `adapters/location_query_statistics-all-columns.py`, 선택한 제한 열 버전은 저장소의126 정본이다.

최종 수집 시 아카이브의 Windows 줄바꿈 차이로 해시 검사가 중단됐다. `core.autocrlf=false`로 정본을 다시 내보내고 Python AST 동일성을 대조했다. 실제 실행 파일과 정본의 최종 SHA-256도 다시 맞췄다. 시험 결과 로그 자체는 변환하지 않았다.

최종 묶음은r2다. 이전r1은 재현 명령의 이전 버전 입력 해시를 Git의LF 대신125에서 실제 보존·실행한 바이트로 고정하는 후속 보완으로 대체했다. 제품 통계 갱신 코드는 동일하다. [r1 원본](candidate-manifest126.json)은 삭제하지 않고, [r2 바이트 대조](post-package-byte-check.json)도 별도로 보존한다. 최신 도구 정본은689a74c다.

126 묶음은125/124 산출물에 의존하는 **재현 도구 묶음이며 운영 설치기가 아니다**. 현재3GB 공유VPS, 실물 LTE/TLS, 실제 백업의 외부 키 보관·과거WAL 파기는 이번 증거의 범위가 아니다.
