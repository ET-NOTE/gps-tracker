#include "../main/verified_tls.h"
#include <cassert>
#include <chrono>
#include <fstream>
#include <iterator>
#include <thread>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <iostream>
static uint32_t clockMs(){return uint32_t(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());}
int main(int argc,char **argv){
  assert(argc==6);
  std::ifstream f(argv[2]);std::string ca((std::istreambuf_iterator<char>(f)),{});
  int sock=socket(AF_INET,SOCK_STREAM,0);assert(sock>=0);
  sockaddr_in peer{};peer.sin_family=AF_INET;peer.sin_port=htons(atoi(argv[1]));inet_pton(AF_INET,"127.0.0.1",&peer.sin_addr);
  assert(connect(sock,reinterpret_cast<sockaddr*>(&peer),sizeof(peer))==0);
  VerifiedTls tls({&sock,
    [](void *p,const unsigned char *data,size_t n){return int(send(*static_cast<int*>(p),data,n,MSG_NOSIGNAL));},
    [](void *p,unsigned char *data,size_t n){int r=recv(*static_cast<int*>(p),data,n,MSG_DONTWAIT);return r<0&&(errno==EAGAIN||errno==EWOULDBLOCK)?0:r==0?-1:r;},
    clockMs,[](){std::this_thread::sleep_for(std::chrono::milliseconds(1));}});
  bool connected=tls.connect(argv[3],ca.c_str());
  const unsigned flags=strtoul(argv[4],nullptr,16);
  if(flags){
    assert(!connected && (tls.verifyFlags()&flags)==flags);
    assert(!tls.write("GET /must-not-send HTTP/1.1\r\n\r\n"));
  }else{
    assert(connected);
    assert(tls.write("GET /tls-probe HTTP/1.1\r\nHost: gps.serial.kr\r\nConnection: close\r\n\r\n"));
    int status=-1;std::string body;bool ok=tls.response(status,body);
    assert(ok==bool(atoi(argv[5])));
    if(ok)assert(status==200 && body=="test");
  }
  std::cout<<"verified="<<connected<<" flags="<<std::hex<<tls.verifyFlags()<<"\n";
  close(sock);
}
