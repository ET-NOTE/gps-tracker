#include "verified_tls.h"
#include <algorithm>
#include <ctype.h>
#include <string.h>
#include <time.h>
#if !defined(MBEDTLS_HAVE_TIME_DATE)
#error "TLS certificate validity-date verification is required"
#endif

VerifiedTls::VerifiedTls(Io io) : io_(io) {
  mbedtls_ssl_init(&ssl_); mbedtls_ssl_config_init(&config_);
  mbedtls_x509_crt_init(&ca_); mbedtls_entropy_init(&entropy_);
  mbedtls_ctr_drbg_init(&random_);
}
VerifiedTls::~VerifiedTls() {
  // The caller closes TCP. Never block teardown on the peer's close_notify.
  mbedtls_ssl_free(&ssl_); mbedtls_ssl_config_free(&config_);
  mbedtls_x509_crt_free(&ca_); mbedtls_ctr_drbg_free(&random_);
  mbedtls_entropy_free(&entropy_);
}
bool VerifiedTls::live() {
  io_.idle();
  if (io_.now()-started_ < 45000) return true;
  error_=MBEDTLS_ERR_SSL_TIMEOUT; return false;
}
int VerifiedTls::sendBio(void *ctx,const unsigned char *p,size_t n) {
  auto &s=*static_cast<VerifiedTls*>(ctx);
  if (!s.live()) return MBEDTLS_ERR_SSL_TIMEOUT;
  int r=s.io_.send(s.io_.context,p,n);
  return r>0?r:MBEDTLS_ERR_SSL_INTERNAL_ERROR;
}
int VerifiedTls::receiveBio(void *ctx,unsigned char *p,size_t n) {
  auto &s=*static_cast<VerifiedTls*>(ctx);
  if (!s.live()) return MBEDTLS_ERR_SSL_TIMEOUT;
  int r=s.io_.receive(s.io_.context,p,n);
  return r>0?r:r==0?MBEDTLS_ERR_SSL_WANT_READ:MBEDTLS_ERR_SSL_INTERNAL_ERROR;
}
bool VerifiedTls::connect(const char *hostname,const char *ca) {
  started_=io_.now(); verified_=false;
  // CCLK/NTP is copied to the MCU before this call. An unset epoch fails closed.
  const time_t now=time(nullptr);
  if (!hostname || !*hostname || !ca || !*ca || now<1767225600 || now>=2208988800) {
    error_=MBEDTLS_ERR_X509_BAD_INPUT_DATA; return false;
  }
  static const unsigned char seed[]="gps-verified-tls";
  if ((error_=mbedtls_ctr_drbg_seed(&random_,mbedtls_entropy_func,&entropy_,seed,sizeof(seed)))!=0 ||
      (error_=mbedtls_x509_crt_parse(&ca_,reinterpret_cast<const unsigned char*>(ca),strlen(ca)+1))!=0 ||
      (error_=mbedtls_ssl_config_defaults(&config_,MBEDTLS_SSL_IS_CLIENT,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT))!=0) return false;
  mbedtls_ssl_conf_authmode(&config_,MBEDTLS_SSL_VERIFY_REQUIRED);
  mbedtls_ssl_conf_ca_chain(&config_,&ca_,nullptr);
  mbedtls_ssl_conf_rng(&config_,mbedtls_ctr_drbg_random,&random_);
  mbedtls_ssl_conf_min_tls_version(&config_,MBEDTLS_SSL_VERSION_TLS1_2);
  mbedtls_ssl_conf_max_tls_version(&config_,MBEDTLS_SSL_VERSION_TLS1_2);
  if ((error_=mbedtls_ssl_setup(&ssl_,&config_))!=0 ||
      (error_=mbedtls_ssl_set_hostname(&ssl_,hostname))!=0) return false;
  mbedtls_ssl_set_bio(&ssl_,this,sendBio,receiveBio,nullptr);
  do { error_=mbedtls_ssl_handshake(&ssl_); }
  while ((error_==MBEDTLS_ERR_SSL_WANT_READ || error_==MBEDTLS_ERR_SSL_WANT_WRITE) && live());
  verifyFlags_=mbedtls_ssl_get_verify_result(&ssl_);
  verified_=error_==0 && verifyFlags_==0;
  return verified_;
}
bool VerifiedTls::write(const std::string &data) {
  if (!verified_) return false;
  size_t sent=0;
  while (sent<data.size() && live()) {
    int r=mbedtls_ssl_write(&ssl_,reinterpret_cast<const unsigned char*>(data.data()+sent),data.size()-sent);
    if (r>0) sent+=r;
    else if (r!=MBEDTLS_ERR_SSL_WANT_READ && r!=MBEDTLS_ERR_SSL_WANT_WRITE) { error_=r; return false; }
  }
  return sent==data.size();
}
int VerifiedTls::read(unsigned char *p,size_t n) {
  if (!verified_) return -1;
  while (live()) {
    int r=mbedtls_ssl_read(&ssl_,p,n);
    if (r>0) return r;
    if (r!=MBEDTLS_ERR_SSL_WANT_READ && r!=MBEDTLS_ERR_SSL_WANT_WRITE) { error_=r; return -1; }
  }
  return -1;
}
bool VerifiedTls::line(std::string &s,size_t max) {
  s.clear();
  while (s.size()<max) {
    unsigned char c;
    if (read(&c,1)!=1) return false;
    if (c=='\n') {
      if (s.empty() || s.back()!='\r') return false;
      s.pop_back(); return true;
    }
    if (c==0) return false;
    s.push_back(c);
  }
  return false;
}
bool VerifiedTls::exact(std::string &s,size_t n) {
  if (n>2047-s.size()) return false;
  unsigned char buffer[256];
  while (n) {
    int r=read(buffer,std::min(n,sizeof(buffer)));
    if (r<=0) return false;
    s.append(reinterpret_cast<char*>(buffer),r); n-=r;
  }
  return true;
}
static bool number(const std::string &s,unsigned base,size_t &n) {
  if (s.empty()) return false;
  n=0;
  for (unsigned char c:s) {
    unsigned v=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:99;
    if (v>=base || n>(2047-v)/base) return false;
    n=n*base+v;
  }
  return n<=2047;
}
bool VerifiedTls::response(int &status,std::string &body) {
  status=-1; body.clear(); std::string s;
  if (!line(s,128) || s.size()<12 || (s.compare(0,9,"HTTP/1.1 ") && s.compare(0,9,"HTTP/1.0 ")) ||
      !isdigit(s[9]) || !isdigit(s[10]) || !isdigit(s[11]) || (s.size()>12 && s[12]!=' ')) return false;
  status=(s[9]-'0')*100+(s[10]-'0')*10+s[11]-'0';
  bool headersComplete=false, hasLength=false, chunked=false; size_t length=0, total=0;
  while (line(s,1024)) {
    total+=s.size()+2; if (total>4096) return false;
    if (s.empty()) { headersComplete=true; break; }
    size_t colon=s.find(':'); if (colon==std::string::npos) return false;
    std::string name=s.substr(0,colon), value=s.substr(colon+1);
    for (char &c:name) c=tolower(static_cast<unsigned char>(c));
    while (!value.empty() && (value.front()==' ' || value.front()=='\t')) value.erase(0,1);
    while (!value.empty() && (value.back()==' ' || value.back()=='\t')) value.pop_back();
    if (name=="content-length") {
      if (hasLength || chunked || !number(value,10,length)) return false;
      hasLength=true;
    } else if (name=="transfer-encoding") {
      for (char &c:value) c=tolower(static_cast<unsigned char>(c));
      if (chunked || hasLength || value!="chunked") return false;
      chunked=true;
    }
  }
  if (!headersComplete) return false;
  if (hasLength) return exact(body,length);
  if (!chunked) return false; // Ambiguous/close-delimited bodies are not signed acknowledgements.
  while (line(s,64)) {
    size_t n;
    if (!number(s,16,n)) return false;
    if (!n) return line(s,1024) && s.empty(); // No trailers are expected from our API.
    if (!exact(body,n) || !line(s,2) || !s.empty()) return false;
  }
  return false;
}
