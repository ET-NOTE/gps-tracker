-- STATUS 분류 (colors.js classifyDevice) 와 1:1 매핑되도록 알림 토글 확장.
--
--   SIGNAL_LOSS  (5~30분 무소식)      → signal_loss_alert      (default off)
--   ONLINE       (offline/signal_loss → 복구) → online_alert    (default on  — 회복은 좋은 소식)
--   SLEEPING     (sleep_enter)        → sleep_alert            (default off — 기술적 이벤트)
--   WAKE         (wake)               → wake_alert             (default off — 기술적 이벤트)
--
--   signal_loss_minutes: 5분이 기본. 통신 두절(offline, 30분) 보다 짧음.
ALTER TABLE notification_settings
    ADD COLUMN IF NOT EXISTS signal_loss_alert   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS online_alert        BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS sleep_alert         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS wake_alert          BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS signal_loss_minutes INT     NOT NULL DEFAULT 5
        CHECK (signal_loss_minutes BETWEEN 1 AND 30);
