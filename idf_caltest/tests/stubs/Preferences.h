#pragma once
#include <map>
#include <string>
#include <stdint.h>
namespace prefs_test {
inline std::map<std::string,uint32_t> values;
inline bool failOpen=false,failWrite=false;
inline int writes=0;
}
class Preferences {
 std::string name;
 public:
 bool begin(const char *ns,bool) { name=ns;return !prefs_test::failOpen; }
 uint32_t getUInt(const char *key,uint32_t fallback) { auto i=prefs_test::values.find(name+"."+key);return i==prefs_test::values.end()?fallback:i->second; }
 size_t putUInt(const char *key,uint32_t value) { if(prefs_test::failWrite)return 0; prefs_test::values[name+"."+key]=value;prefs_test::writes++;return sizeof(uint32_t); }
 void end() {}
};
