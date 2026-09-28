#pragma once
struct FakeWire {
  void begin() {}
  void beginTransmission(int) {}
  int endTransmission() { return 1; }
};
inline FakeWire Wire;
