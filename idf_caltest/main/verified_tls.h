#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string>
#include <mbedtls/ssl.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/x509_crt.h>

// The transport carries only TLS records. No HTTP bytes may reach it until
// VERIFY_REQUIRED, CA/date and hostname verification have all succeeded.
class VerifiedTls {
 public:
  struct Io {
    void *context;
    int (*send)(void*, const unsigned char*, size_t);
    int (*receive)(void*, unsigned char*, size_t); // 0 = no data yet, negative = failure
    uint32_t (*now)();
    void (*idle)();
  };
  explicit VerifiedTls(Io io);
  ~VerifiedTls();
  VerifiedTls(const VerifiedTls&) = delete;
  VerifiedTls& operator=(const VerifiedTls&) = delete;
  bool connect(const char *hostname, const char *ca);
  bool write(const std::string &data);
  bool response(int &status, std::string &body);
  int error() const { return error_; }
  uint32_t verifyFlags() const { return verifyFlags_; }
 private:
  static int sendBio(void*,const unsigned char*,size_t);
  static int receiveBio(void*,unsigned char*,size_t);
  int read(unsigned char*,size_t);
  bool line(std::string&,size_t);
  bool exact(std::string&,size_t);
  bool live();
  Io io_;
  mbedtls_ssl_context ssl_;
  mbedtls_ssl_config config_;
  mbedtls_x509_crt ca_;
  mbedtls_entropy_context entropy_;
  mbedtls_ctr_drbg_context random_;
  bool verified_ = false;
  int error_ = 0;
  uint32_t verifyFlags_ = 0, started_ = 0;
};
