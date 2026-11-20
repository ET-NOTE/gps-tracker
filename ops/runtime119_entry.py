"""Guarded entry for the fixed isolated round119 profiles, before key loading.

This is not a production installer. The runtime image owns the configuration,
guard and preload library; only these three fixed budgets are accepted.
"""
import json
import os
from pathlib import Path
import sys

from runtime118_guard import verify, require


def main():
    profile = os.environ.get('GPS_RUNTIME_PROFILE', 'api')
    require(profile in ('api', 'controller', 'proxy', 'db-memory', 'db-recovery', 'db-disk'), 'unknown protected profile')
    result = verify('/etc/gps119/' + profile + '.json')
    # No credentials, arguments or document bytes in evidence.
    print('GPS119 protection ' + json.dumps(dict(profile=profile, **result)), file=sys.stderr, flush=True)
    require(len(sys.argv) > 1, 'missing protected command')
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('GPS119 startup refused: ' + str(error), file=sys.stderr)
        sys.exit(78)
