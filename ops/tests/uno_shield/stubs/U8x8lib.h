#pragma once
#define U8X8_PIN_NONE 0
inline const uint8_t u8x8_font_chroma48medium8_r[]={0};
class U8X8_SSD1306_128X64_NONAME_HW_I2C {
public:
  explicit U8X8_SSD1306_128X64_NONAME_HW_I2C(int) {}
  void setI2CAddress(int) {}
  void begin() {}
  void setBusClock(int) {}
  void setFont(const uint8_t*) {}
  void clear() {}
  void drawString(int,int,const char*) {}
};
