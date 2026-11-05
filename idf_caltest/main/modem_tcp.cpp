#include "modem_tcp.h"
#include "loopwdt.h"
#include <algorithm>
#include <stdio.h>
#include <string.h>

int ModemTcp::byte(uint32_t start,uint32_t timeout) {
  while (millis()-start<timeout) {
    lwdt::feed();
    if (serial_.available()) return serial_.read();
    delay(1);
  }
  return -1;
}
bool ModemTcp::line(char *out,size_t cap,uint32_t start,uint32_t timeout) {
  size_t n=0;
  while (n+1<cap) {
    int c=byte(start,timeout); if (c<0 || c==0) return false;
    if (c=='\n') { if (n && out[n-1]=='\r') --n; out[n]=0; return true; }
    out[n++]=static_cast<char>(c);
  }
  return false;
}
bool ModemTcp::ok(uint32_t start,uint32_t timeout) {
  char s[160];
  while (line(s,sizeof(s),start,timeout)) {
    if (!strcmp(s,"OK")) return true;
    if (!strcmp(s,"ERROR") || strstr(s,"+CME ERROR:") || !strcmp(s,"RDY")) return false;
  }
  return false;
}
bool ModemTcp::command(const char *cmd) {
  serial_.print(cmd); serial_.print("\r\n");
  return ok(millis(),5000);
}
void ModemTcp::close() {
  command("AT+CACLOSE=0"); opened_=false;
  // Consume trailing notifications before the next command; never a data-mode socket.
  uint32_t start=millis();
  while (millis()-start<50) { while (serial_.available()) serial_.read(); delay(1); }
}
bool ModemTcp::open(const char *host,unsigned port) {
  close();
  // TLS is implemented on the MCU. This raw socket must carry only TLS records.
  if (!command("ATE0") || !command("AT+CASSLCFG=0,\"SSL\",0") || !command("AT+CASRIP=0")) return false;
  char cmd[128];
  int n=snprintf(cmd,sizeof(cmd),"AT+CAOPEN=0,0,\"TCP\",\"%s\",%u,0",host,port);
  if (n<0 || static_cast<size_t>(n)>=sizeof(cmd)) return false;
  serial_.print(cmd); serial_.print("\r\n");
  uint32_t start=millis(); bool ack=false, connected=false; char s[160];
  while (line(s,sizeof(s),start,30000)) {
    if (!strcmp(s,"OK")) ack=true;
    if (!strncmp(s,"+CAOPEN:",8)) {
      int id=-1,result=-1;
      if (sscanf(s,"+CAOPEN: %d,%d",&id,&result)!=2 || id!=0 || result!=0) return false;
      connected=true;
    }
    if (!strcmp(s,"ERROR") || strstr(s,"+CME ERROR:") || !strcmp(s,"RDY")) return false;
    if (ack && connected) { opened_=true; return true; }
  }
  return false;
}
int ModemTcp::send(const unsigned char *p,size_t n) {
  if (!opened_ || !n) return -1;
  n=std::min(n,size_t(1024));
  char cmd[64]; snprintf(cmd,sizeof(cmd),"AT+CASEND=0,%u,10000",unsigned(n));
  serial_.print(cmd); serial_.print("\r\n");
  uint32_t start=millis(); int c; size_t skipped=0;
  while ((c=byte(start,3000))>=0 && c!='>' && ++skipped<512) {}
  if (c!='>') return -1;
  serial_.write(p,n);
  return ok(millis(),10000)?int(n):-1;
}
int ModemTcp::receive(unsigned char *p,size_t n) {
  if (!opened_ || !n) return -1;
  n=std::min(n,size_t(768));
  char cmd[64]; snprintf(cmd,sizeof(cmd),"AT+CARECV=0,%u",unsigned(n));
  serial_.print(cmd); serial_.print("\r\n");
  uint32_t start=millis(); char prefix[160]; size_t used=0;
  // Match a header at a line boundary, then consume a bounded decimal length.
  while (true) {
    int c=byte(start,5000); if (c<0 || c==0 || used+1>=sizeof(prefix)) return -1;
    if (c=='\n') {
      prefix[used]=0;
      if (strstr(prefix,"ERROR") || strstr(prefix,"RDY")) return -1;
      used=0; continue;
    }
    prefix[used++]=static_cast<char>(c); prefix[used]=0;
    if (!strcmp(prefix,"+CARECV:")) break;
  }
  size_t length=0; bool digit=false; int separator=-1;
  while (true) {
    int c=byte(start,5000); if (c<0) return -1;
    if (c==' ' && !digit) continue;
    if (c>='0' && c<='9') {
      digit=true; length=length*10+(c-'0'); if (length>n) return -1;
    } else { separator=c; break; }
  }
  if (!digit || (length && separator!=',') || (!length && separator!=',' && separator!='\r')) return -1;
  for (size_t i=0;i<length;++i) { int c=byte(start,5000); if (c<0) return -1; p[i]=static_cast<unsigned char>(c); }
  if (!ok(start,5000)) return -1;
  if (!length) delay(30);
  return static_cast<int>(length);
}
