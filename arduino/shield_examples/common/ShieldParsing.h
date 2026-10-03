#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

namespace shield_example {
inline bool digits(const char *s, unsigned n) {
  for (unsigned i=0;i<n;i++) if (s[i]<'0'||s[i]>'9') return false;
  return true;
}
inline unsigned two(const char *s) { return (s[0]-'0')*10U+s[1]-'0'; }
inline uint32_t epoch(unsigned y,unsigned m,unsigned d,unsigned h,unsigned n,unsigned s) {
  if(y<2024||y>2099||m<1||m>12||d<1||h>23||n>59||s>59) return 0;
  const uint8_t days[]={31,28,31,30,31,30,31,31,30,31,30,31};
  if(d>static_cast<unsigned>(days[m-1])+(m==2&&y%4==0)) return 0;
  uint32_t total=0;
  for(unsigned a=1970;a<y;a++) total+=a%4==0?366:365;
  for(unsigned a=1;a<m;a++) total+=days[a-1]+(a==2&&y%4==0);
  return (((total+d-1)*24+h)*60+n)*60+s;
}
inline uint32_t clockEpoch(const char *s) {
  // CCLK: yy/MM/dd,hh:mm:ss+zz (zz is signed quarters of an hour).
  if(strlen(s)!=20||s[2]!='/'||s[5]!='/'||s[8]!=','||s[11]!=':'||s[14]!=':'||
     (s[17]!='+'&&s[17]!='-')) return 0;
  const uint8_t at[]={0,3,6,9,12,15,18};
  for(uint8_t i=0;i<7;i++) if(!digits(s+at[i],2)) return 0;
  const unsigned zone=two(s+18);
  uint32_t t=epoch(2000+two(s),two(s+3),two(s+6),two(s+9),two(s+12),two(s+15));
  if(!t||zone>56) return 0;
  return s[17]=='+' ? t-zone*900UL : t+zone*900UL;
}
inline bool decimal(const char *s,double low,double high) {
  const char *p=s; if(*p=='-') ++p;
  if(*p<'0'||*p>'9') return false;
  if(*p=='0'&&p[1]>='0'&&p[1]<='9') return false;
  while(*p>='0'&&*p<='9') ++p;
  if(*p=='.') { ++p; if(*p<'0'||*p>'9') return false; while(*p>='0'&&*p<='9') ++p; }
  return !*p && atof(s)>=low && atof(s)<=high;
}
inline bool safeToken(const char *s,unsigned max) {
  unsigned n=strlen(s); if(!n||n>max||strstr(s,"YOUR_")) return false;
  for(unsigned i=0;i<n;i++) if(!((s[i]>='a'&&s[i]<='z')||(s[i]>='A'&&s[i]<='Z')||
      (s[i]>='0'&&s[i]<='9')||s[i]=='-'||s[i]=='_'||s[i]=='.')) return false;
  return true;
}
inline bool hexKey(const char *s) {
  if(strlen(s)!=64) return false;
  for(unsigned i=0;i<64;i++) if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f'))) return false;
  return true;
}
struct Fix { uint32_t at; char lat[15],lng[15]; uint8_t satellites; };
inline bool gnss(char *csv,Fix &fix) {
  // Destructive split preserves empty reserved fields. CGNSINF field 14 = satellites in view.
  char *f[15]; unsigned count=0; char *p=csv;
  while(*p==' ') ++p;
  while(count<15) { f[count++]=p; char *comma=strchr(p,','); if(!comma) break; *comma=0;p=comma+1; }
  if(count<15||strcmp(f[0],"1")||strcmp(f[1],"1")) return false;
  const size_t len=strlen(f[2]);
  if((len!=14&&len!=18)||!digits(f[2],14)||(len==18&&(f[2][14]!='.'||!digits(f[2]+15,3)))) return false;
  const char *t=f[2];
  uint32_t at=epoch(two(t)*100+two(t+2),two(t+4),two(t+6),two(t+8),two(t+10),two(t+12));
  if(!at||strlen(f[3])>=sizeof(fix.lat)||strlen(f[4])>=sizeof(fix.lng)||
     !decimal(f[3],-90,90)||!decimal(f[4],-180,180)||!decimal(f[10],0.1,5.0)) return false;
  size_t sn=strlen(f[14]); if(!sn||sn>2||!digits(f[14],sn)||atoi(f[14])<4) return false;
  fix.at=at;strcpy(fix.lat,f[3]);strcpy(fix.lng,f[4]);fix.satellites=atoi(f[14]); return true;
}
}
