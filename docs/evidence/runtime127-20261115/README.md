# 127차 실제 검증 증거

2026-11-15, 빌드 호스트의 격리 합성 시험이다. **운영 화면·운영 부하·실물 단말기 검증이 아니다.** 후보114/API`5c6f4529207f9ab0d5d30598dbb4fe8a4e4b77dc4e5304a8736f311fdcdb7e52`, 마지막 확인 운영99와 구분한다. [결과와 남은 항목](../../operations/location-business-runtime127-20261115.md).

| 확인 항목 | 원본 |
|---|---|
| 변경 전후 단일 월간3경로·응답 해시·임시 공간 |[paired-probe127.json](paired-probe127.json)|
| 기존113 압축 동시 실패 재현,60초 |[sustained127-baseline-compressed.json](sustained127-baseline-compressed.json)|
| 후보114 압축 동시 부하,300초 |[sustained127-compressed.json](sustained127-compressed.json)|
| 후보114 비압축 동시 부하,300초 |[sustained127-uncompressed.json](sustained127-uncompressed.json)|
| 각113 백업 복원→114 전환·통계·재시작 뒤 첫 조회 |[압축 복원](restored127-compressed.json),[압축 재시작](restarted127-compressed.json),[비압축 복원](restored127-uncompressed.json),[비압축 재시작](restarted127-uncompressed.json)|
| 실제 제한 역할·JIT OFF 실행계획/임시 블록 |[집계](plan127-aggregate.json),[이력](plan127-history.json)|
| 비슈퍼유저114 마이그레이션·실패 원복·물리 암호문 불변 |[migration127.json](migration127.json),[99→113 앞 구간](cumulative121.json)|
|585개 경계·변경·권한·키 검사 |[boundary127.json](boundary127.json)|
| 압축15개 전체 행 동등성·타소유자5건·키 없음 |[compressed-oracle127.json](compressed-oracle127.json)|
| 정비 차단/권한·미검토115 거부·실제 복제본 권리 잠금 |[statistics-guards126.json](statistics-guards126.json) —126 검사기를114 후보/115 거부로 어댑트|
| 동의·철회·정보주체 매핑·제공 경계 |[22](round22-encrypted-integration.json),[22B](round22b-encrypted.json),[22D](round22d-encrypted.json),[실행 목록](regressions121.json)|
|PDF7개 업무 |[receipt-pdf-validation.json](receipt-pdf-validation.json)|
|TLS 취소·429·이력 대기 공정성 |[fairness124.json](fairness124.json),[cancellation122.json](cancellation122.json) —기존 검사기를 이번114 후보에 실행|
| 최종 평문·임시 이미지·대기·열린 거래0 |[final-state127.json](final-state127.json)|
| 실제 API/DB 출력 |[API journal](api127-journal.log),[DB journal](db127-journal.log)|
| 빌드·설치한 코드·격리 한도 |[build127.json](build127.json),[실제 실행 소스](running-source127.json),[isolation127.json](isolation127.json),[마이그레이션 정본](migration-bytes.json)|
| 실행 시작·경과·종료 코드·실패 포함 |[commands.jsonl](commands.jsonl)|
| 보존 파일·다른 서비스 불변과 정리 |[host-before.json](host-before.json),[host-after.json](host-after.json)|
| 최종 후보 묶음과 의존 해시 |[candidate-manifest127.json](candidate-manifest127.json)|

후보 압축은HTTP200194/429177, 비압축은200170/429171이다.429에는 재시도가 포함된다. 최종429로 끝난 논리 요청은 각각53/36건이다. 두 후보에서500/408·새OOM·swap·잔류 조회는0이다. 임시 공간 표본 최고164.07/171.74MiB, 보호 상한256MiB다. 성공 응답 바이트가 기존과 같다. 운영의429/대기시간 인수나3GB 공유 VPS 용량 합격을 뜻하지 않는다.

실패도 보존한다. 초기 뷰 열 참조 오류(`040501`), 압축 보정 쓰기의10만 해제 한도(`041258`), 시험 연결의 잠금 해제 경합(`041338`), 통계 검사 전 차단 상태 누락(`041421`) 로그는 삭제하지 않았다. `040616` 실험의`before-uncompressed`는 직전 실패의 압축 상태가 남은 진단이므로 비압축 대조로 쓰지 않는다. 최종 단일 대조는 명시적으로 압축을 해제하고 원래113 함수를 복원한`040757`/`paired-probe127.json`이다. 보정 쓰기 해제 한도는 제품에서 미해결이며 다음 라운드 대상이다. 생성된 어댑터·입력 해시도 보존한다.

[remote-byte-check.json](remote-byte-check.json)은 빌드 호스트 원본74개의 크기/해시다. 실제 무작위 시험 키와 DB 비밀번호 문자열이 포함되지 않았는지 검사한 뒤 내보냈다. 원본 아카이브SHA는`e4634644e6e289fe9ab4357b4d9a5e88250c30b3475910dd4eae93b1d3f7b6f6`이다. 추후 추가한 정리·묶음 기록은 별도의 바이트 대조를 남긴다. [.gitattributes](.gitattributes)가 원본 줄바꿈을 보존하며[sha256.json](sha256.json)이 이 디렉터리 최종 파일들을 검증한다.
