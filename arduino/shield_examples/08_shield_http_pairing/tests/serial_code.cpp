#include "DemoCodeInput.h"
#include <cassert>
#include <iostream>

int main() {
  DemoCodeInput input;
  char code[38] = {};
  std::string valid = "demo-" + std::string(32, 'a');
  for (char c : valid) assert(input.feed(c, code) == 0);
  assert(code[0] == 0); // Partial line cannot authenticate.
  assert(input.feed('\r', code) == 1 && std::string(code) == valid);
  assert(input.feed('\n', code) == 0); // CRLF does not erase accepted data.
  for (const auto &bad : {std::string(500, 'x') + valid, valid + "x", valid.substr(1),
                         " " + valid, std::string(64, 'a'), std::string("abcd-1234-ef56-7890"),
                         "demo-" + std::string(32, 'A'), "demo-" + std::string(32, 'g'),
                         "demo-" + std::string(31, 'a') + std::string(1, '\t')}) {
    for (char c : bad) input.feed(c, code);
    assert(input.feed('\n', code) == -1 && std::string(code) == valid);
  }
  std::string next = "demo-" + std::string(32, 'b');
  for (char c : next) input.feed(c, code);
  assert(input.feed('\n', code) == 1 && std::string(code) == next);
  std::cout << "HTTP serial code: bounded input, CRLF, 9 malformed forms and replacement passed.\n";
}
