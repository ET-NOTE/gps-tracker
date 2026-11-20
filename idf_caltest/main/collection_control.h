#pragma once
#include <Arduino.h>
struct cJSON;
namespace collection_control {
// Every boot starts closed until an authenticated policy for the current SIM.
void begin();
void syncSim(const char *sim);
bool allowed();
void applyAuthenticatedResponse(const char *body);
void prepare(cJSON *payload);
}
