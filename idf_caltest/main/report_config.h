#pragma once
#include <stdint.h>
namespace report_config {
void begin();
uint32_t intervalS();
bool persisted();
// Caller must first verify the server HMAC and match this request's counter.
bool applyAuthenticatedResponse(const char *json);
bool useDefault();
}
