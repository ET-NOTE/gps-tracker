---
title: "ESP32-C3 + LTE + GPS 트래커 만들며"
description: "PCB rev 3번 · GPS 모듈 2종 · 부저 회로 재작업 · LTE 극성 반전 · INT-WDT 몇 시간 offline · WS 만료 loop · 다 겪었다. 사후 정리가 아니라 왔다갔다한 흔적 그대로."
draft: false
tags: ["esp32", "lte", "sim7080", "gps", "rust", "axum", "react", "kakao-maps"]
---

# 개요

이 폴더는 프로젝트 스토리를 챕터별로. Repository 는 [github.com/ET-NOTE/gps-tracker](https://github.com/ET-NOTE/gps-tracker), 태그 [v1.0-blog](https://github.com/ET-NOTE/gps-tracker/tree/v1.0-blog) 로 발행 시점 스냅샷 고정.

## 목차

| # | 챕터 | 상태 |
|---|---|---|
| 1 | [왜 만들었나](01-why.md) | ✅ 완성 |
| 2 | [아키텍처 큰 그림](02-architecture.md) | ✅ 완성 |
| 3 | [하드웨어 진화 (PCB rev · GPS 세대 · 부저 재앙)](03-hardware.md) | ✅ 완성 |
| 4 | [펌웨어 리팩터 (Arduino → IDF)](04-firmware.md) | ✅ 완성 |
| 5 | [서버 (Rust + axum + Timescale)](05-server.md) | ✅ 완성 |
| 6 | [프론트 (React + Kakao Maps)](06-frontend.md) | ✅ 완성 |
| 7 | [모바일 (Flutter WebView + FCM)](07-mobile.md) | ✅ 완성 |
| 8 | [실전 사고 — 며칠씩 파고든 것들](08-troubleshooting.md) | ✅ 완성 |
| 9 | [회고 — 다시 시작한다면](09-retro.md) | ✅ 완성 |

**전체 사고 log** (10+ 케이스, 서사식): [docs/troubleshooting.md](../troubleshooting.md)
**하드웨어 상세 spec**: [docs/hardware.md](../hardware.md)
**시스템 아키텍처 상세**: [architecture.md](../../architecture.md)
**현재 진행 상태**: [STATUS.md](../../STATUS.md)

## 원칙

- **왔다갔다 흔적 유지**: 최종 config 만 보여주면 "정답이 처음부터 있었다" 는 인상. 실제로는 8가지 pin 조합 다 시도한 후 알아낸 것들. 그 과정을 시간순으로.
- **서사 우선**: "왜 이 결정?" 이 항상 "무엇을 결정?" 보다 중요.
- **재현 가능** (하드웨어 있으면): 부품 BOM, 회로도, firmware flash, 서버 셋업 순차 가이드.
- **매끈함 배제**: 실패한 branch, 회수된 커밋, 사후 발견한 log 도 담기.

## 발행 정책

- **`v1.0-blog`** = 초판 스냅샷 (챕터 1-3 · 8-9 완성, 4-7 draft)
- **`v1.1-blog`** = 챕터 1-9 모두 완성 (2026-07-25)
- 이후 갱신 시 `v1.x-blog` 새 태그. 이전 태그 링크는 유지 (안정 참조)
- 개인 블로그 (Astro 등) 에 옮겨 게시할 계획
