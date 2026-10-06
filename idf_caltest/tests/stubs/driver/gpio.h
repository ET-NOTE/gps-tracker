#pragma once
#include "Arduino.h"
using gpio_num_t = int;
esp_err_t gpio_hold_en(gpio_num_t);
esp_err_t gpio_hold_dis(gpio_num_t);
void gpio_deep_sleep_hold_en();
void gpio_deep_sleep_hold_dis();
