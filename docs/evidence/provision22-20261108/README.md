# 22차 격리 검증 증빙

운영 배포나 실제 휴대폰 수신 증빙이 아니다. 합성 계정·자료, 내부 Docker 네트워크, tmpfs DB를 사용했다. validation-summary.json, source-manifest.json, candidate-manifest.json, package-verification.json, SHA256SUMS를 함께 확인한다.

source-manifest는 Git 텍스트 줄바꿈을 정규화한 입력 해시다. 적용된 SQL migration은 원본 바이트, PNG/ICO/TTF도 원본 바이트를 보존한다. 실제 소스/실행 파일과 일치하지 않는 캐시 시험 결과는 최종 결과로 쓰지 않았다.

UI: 실제 SubjectProvision React 컴포넌트와 합성 API 응답. ui-harness.html/.jsx를 웹 폴더의 qa22.html/.jsx로 임시 복사하고 VITE_BASE=/ 로 Vite를127.0.0.1:8214에 띄운 뒤 ui-capture.cjs를 저장소 루트에서 실행한다. 이 스크립트는 TEMP/gps-admin19-qa/node_modules/playwright와 Edge를 사용한다. 본인 확인·철회·열람 표시를 확인하고 PC1280/모바일390을 캡처했다. 끝나면 서버와 임시 진입점을 제거한다.

실제 API 권한·DB·복원·통보 재시도는 별도 통합 시험 로그로 확인한다. UI의 모의 응답으로 API 통과를 주장하지 않는다. 메일·FCM 외부 발송은0건이다. 시험 비밀값과 DB 사본은 포함하지 않는다.

후보65파일과 압축파일 내부 바이트를 모두 대조했다. 소스 커밋은 `0c3bd6bc42492e402963247191997a3006ac164c`이며 운영 미배포다. 빌드 호스트의 source.tar.gz도 검증된774개 입력의 원본 바이트와 최신mtime으로 다시 작성·대조했다. 새 개발은 Git에서 위 커밋 또는 후속 문서 커밋을 받는 것을 기준으로 한다.
