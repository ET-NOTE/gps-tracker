#pragma once
#include "Arduino.h"
enum esp_sleep_wakeup_cause_t { ESP_SLEEP_WAKEUP_UNDEFINED, ESP_SLEEP_WAKEUP_GPIO,
  ESP_SLEEP_WAKEUP_TIMER, ESP_SLEEP_WAKEUP_ALL };
constexpr int ESP_GPIO_WAKEUP_GPIO_LOW = 0;
esp_err_t esp_deep_sleep_enable_gpio_wakeup(uint64_t, int);
esp_err_t esp_sleep_enable_timer_wakeup(uint64_t);
esp_err_t esp_sleep_disable_wakeup_source(esp_sleep_wakeup_cause_t);
void esp_deep_sleep_start();
esp_sleep_wakeup_cause_t esp_sleep_get_wakeup_cause();
uint64_t esp_sleep_get_gpio_wakeup_status();
