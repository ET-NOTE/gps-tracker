#!/usr/bin/env python3
"""Forced SSH command: exposes only the newest Shield archive, no arguments."""
import os
from pathlib import Path
import shutil
import sys

assert os.geteuid()==0
root=Path('/var/backups/shield')
archive=(root/'latest.tar.gz').resolve(strict=True)
assert archive.parent==root and archive.name.startswith('shield-') and archive.name.endswith('.tar.gz')
with archive.open('rb') as source:shutil.copyfileobj(source,sys.stdout.buffer)
