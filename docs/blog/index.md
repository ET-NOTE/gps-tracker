---
title: "ESP32-C3 + LTE + GPS 트래커 만들며"
description: "PCB rev 3번 · GPS 모듈 2종 · 부저 회로 재작업 · LTE 극성 반전 · INT-WDT 몇 시간 offline · WS 만료 loop · 다 겪었다. 사후 정리가 아니라 왔다갔다한 흔적 그대로."
draft: true
tags: ["esp32", "lte", "sim7080", "gps", "rust", "axum", "react", "kakao-maps"]
---

# 개요 (draft)

이 폴더는 블로그 원고 draft. 발행 시점에 `v1.0-blog` 태그 찍고, 개인 블로그 (Astro/Hugo 등) 에 옮겨 게시. 저장소 참조는 태그 링크 (`https://github.com/ET-NOTE/gps-tracker/tree/v1.0-blog`) 로.

## 목차 계획

1. **왜 시작했나** — 문제 정의, 대안 검토 (스마트폰 GPS + 앱? 상용 트래커?)
2. **아키텍처 큰 그림** — [architecture.md](../../architecture.md) 요약본
3. **하드웨어 진화** — PCB rev 3번, GPS 두 세대, 부저와 LTE 의 다툼. → [hardware.md](../hardware.md)
4. **펌웨어 리팩터** — Arduino → IDF (arduino-esp32 as component). Block 별 이관. `13_4_aa` → `idf_caltest` (15_a_modular).
5. **서버 (Rust + axum + Timescale)** — location_records hypertable, JSONB raw, POST-단위 grouping, WebSocket broadcast.
6. **프론트 (React + Kakao Maps)** — 실시간 마커, 폴리라인 gap segment, seeker (일간/월간).
7. **모바일 (Flutter WebView + FCM)** — 최소 셸, native FCM 만.
8. **실전 사고들** (dirty 감 잔뜩!) — [troubleshooting.md](../troubleshooting.md)
9. **회고와 다음 라운드** — 뭘 다르게 했으면. 다음 하드웨어 rev 어디로.

## 원칙

- **왔다갔다 흔적 유지**: 최종 config 만 보여주면 "정답이 처음부터 있었다" 는 인상. 실제로는 8가지 pin 조합 다 시도한 후 알아낸 것들. 그 과정을 시간순으로.
- **서사 우선**: "왜 이 결정?" 이 항상 "무엇을 결정?" 보다 중요.
- **재현 가능** (하드웨어 있으면): 부품 BOM, 회로도, firmware flash, 서버 셋업 순차 가이드.
- **매끈함 배제**: 실패한 branch, 회수된 커밋, 사후 발견한 log 도 담기.

## Draft 상태

| 챕터 | 상태 |
|---|---|
| 1. 왜 | 미작성 |
| 2. 아키텍처 | 기존 [architecture.md](../../architecture.md) 참조 만. 요약 필요 |
| 3. 하드웨어 | [hardware.md](../hardware.md) 완성 → 서사식 재편 필요 |
| 4. 펌웨어 리팩터 | idf_caltest/main/main.cpp 헤더 주석에 이관 이력 있음 (Block 1~8). 정리 필요 |
| 5. 서버 | 미작성 (Phase 1/6 스키마 진화 흔적 정리) |
| 6. 프론트 | PR 히스토리 (#116~131) 가 서사. 정리 필요 |
| 7. 모바일 | Flutter app 은 별도 (로컬 유지). 요약 |
| 8. 사고 | [troubleshooting.md](../troubleshooting.md) 완성 → 그대로 재사용 or 요약 |
| 9. 회고 | 발행 직전에 |

## 관련 링크

- [architecture.md](../../architecture.md) — 시스템 흐름
- [hardware.md](../hardware.md) — PCB · 부품
- [troubleshooting.md](../troubleshooting.md) — 사고 log
- [STATUS.md](../../STATUS.md) — 현재 진행 상태
