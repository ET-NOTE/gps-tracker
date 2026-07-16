#include "breadcrumb.h"
#include <string.h>

namespace bc {

RTC_DATA_ATTR static char lastOp_[24] = "?";

void set(const char *op) {
  strncpy(lastOp_, op, sizeof(lastOp_) - 1);
  lastOp_[sizeof(lastOp_) - 1] = 0;
}

const char* last() { return lastOp_; }

} // namespace bc
