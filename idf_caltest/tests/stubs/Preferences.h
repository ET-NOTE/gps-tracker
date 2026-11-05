#pragma once
#include <map>
#include <string>
#include <stdint.h>
namespace prefs_test {
inline std::map<std::string,uint32_t> values;
inline std::map<std::string,std::string> strings;
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
 String getString(const char *key,const char *fallback) {auto i=prefs_test::strings.find(name+"."+key);return i==prefs_test::strings.end()?String(fallback):String(i->second);}
 size_t putString(const char *key,const char *value) {if(prefs_test::failWrite)return 0;prefs_test::strings[name+"."+key]=value;prefs_test::writes++;return strlen(value);}
};
