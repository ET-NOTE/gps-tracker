#pragma once
#include "Arduino.h"
struct esp_task_wdt_config_t { uint32_t timeout_ms, idle_core_mask; bool trigger_panic; };
inline esp_err_t esp_task_wdt_init(esp_task_wdt_config_t*) { return ESP_OK; }
inline void esp_task_wdt_reconfigure(esp_task_wdt_config_t*) {}
inline void esp_task_wdt_add(void*) {}
inline void esp_task_wdt_reset() {}
