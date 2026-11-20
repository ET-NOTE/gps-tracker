#pragma once
#include <HardwareSerial.h>
#include <stdint.h>
namespace secure_http {
bool exchange(HardwareSerial&,bool probe,const char *body,uint64_t counter,
              const char *signature,const char *uid,int &status,String &response);
}
