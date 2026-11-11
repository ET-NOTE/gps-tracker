#!/usr/bin/env python3
"""Container supervisor: raw ModSecurity messages NEVER reach persistent journals."""
import datetime
import json
import re
import subprocess
import sys


def main():
    child = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    # Bounded line buffering even if an attacker induces a large diagnostic message.
    while True:
        chunk = child.stdout.readline(16384)
        if not chunk:
            break
        line = chunk.decode('utf-8', errors='replace')
        complete = chunk.endswith(b'\n')
        while not complete:
            rest = child.stdout.readline(16384)
            if not rest or rest.endswith(b'\n'):
                break
        ids = re.findall(r'\[id "([0-9]{1,10})"\]', line)
        category = 'waf_rule' if ids else 'startup' if 'notice' in line else 'runtime_error'
        print(json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'category': category, 'rule_ids': ids, 'denied': 'Access denied' in line}), flush=True)
    return child.wait()


if __name__ == '__main__':
    sys.exit(main())
