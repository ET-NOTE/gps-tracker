"""Round123: reuse exact122 workload, compare old/new admission, longer runs."""
import hashlib
from pathlib import Path
import sys
import load_runtime122 as load

ROOT = load.ROOT
PREVIOUS = '56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536'


def select(previous=False):
    load.stop_api()
    name = 'gps-tracker-api.previous' if previous else 'gps-tracker-api'
    target = ROOT/'out'/name
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    assert digest == (PREVIOUS if previous else (ROOT/'candidate123.sha256').read_text().strip())
    link = Path('/opt/gps-tracker-api')
    assert link.is_symlink() and link.resolve().parent == ROOT/'out'
    link.unlink(); link.symlink_to(target)
    load.b.SHA = digest
    load.start(300)


if __name__ == '__main__':
    action = sys.argv[1]
    load.b.SHA = (ROOT/'candidate123.sha256').read_text().strip()
    if action == 'seed': load.seed()
    elif action in ('baseline','dedicated','shared'):
        select(action == 'baseline')
        try:
            if action == 'shared': load.shared(True)
            load.load('baseline-4g' if action == 'baseline' else action+'-123',300 if action == 'baseline' else 900)
        finally:
            if action == 'shared': load.shared(False)
    elif action == 'candidate': select()
    else: raise ValueError(action)
