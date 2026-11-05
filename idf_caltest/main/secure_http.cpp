#include "secure_http.h"
#include "config.h"
#include "modem_tcp.h"
#include "verified_tls.h"
#include "loopwdt.h"
#include <memory>
#include <new>
#include <inttypes.h>
#if GPS_TLS_CERT_TEST
#include GPS_TLS_TEST_CA_HEADER
#else
#include "ingest_root_ca.h"
#endif

bool secure_http::exchange(HardwareSerial &serial,bool probe,const char *body,uint64_t counter,
                           const char *signature,const char *uid,int &status,String &response) {
  status=-1; response="";
  ModemTcp tcp(serial);
  struct Close { ModemTcp &tcp; ~Close() { tcp.close(); } } close{tcp};
#if GPS_TLS_CERT_TEST
  constexpr unsigned port=18443;
#else
  constexpr unsigned port=443;
#endif
  if (!tcp.open(INGEST_HOSTNAME,port)) { Serial.println("[TLS] TCP open failed"); return false; }
  VerifiedTls::Io io{&tcp,
    [](void *p,const unsigned char *data,size_t n){ return static_cast<ModemTcp*>(p)->send(data,n); },
    [](void *p,unsigned char *data,size_t n){ return static_cast<ModemTcp*>(p)->receive(data,n); },
    [](){ return uint32_t(millis()); }, [](){ lwdt::feed(); delay(1); }};
  std::unique_ptr<VerifiedTls> tls(new(std::nothrow) VerifiedTls(io));
  if (!tls) return false;
  bool verified=tls->connect(INGEST_HOSTNAME,gpsRootCa);
  Serial.printf("[TLS-VERIFY] engine=esp32_mbedtls verified=%d error=%d flags=%08lx\n",
                int(verified),tls->error(),(unsigned long)tls->verifyFlags());
  if (!verified) return false; // No credentials or HTTP bytes before verification.
  std::string request=probe?"GET ":"POST ";
  request+=POST_PATH " HTTP/1.1\r\nHost: " INGEST_HOSTNAME;
  if (port!=443) request+=":"+std::to_string(port);
  request+="\r\nConnection: close\r\n";
  if (!probe) {
    char count[32]; snprintf(count,sizeof(count),"%" PRIu64,counter);
    request+="Content-Type: application/json\r\nX-GPS-Auth-Version: 2\r\nX-GPS-UID: ";
    request+=uid; request+="\r\nX-GPS-Counter: "; request+=count;
    request+="\r\nX-GPS-Signature: "; request+=signature;
    request+="\r\nContent-Length: "+std::to_string(strlen(body))+"\r\n";
  }
  request+="\r\n";
  if (!probe) request+=body;
  std::string result;
  if (!tls->write(request) || !tls->response(status,result)) {
    Serial.printf("[TLS] exchange failed error=%d status=%d\n",tls->error(),status); return false;
  }
  response=result.c_str();
  return true;
}
