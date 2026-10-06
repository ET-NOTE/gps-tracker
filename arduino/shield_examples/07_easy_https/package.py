"""Compatibility entry point for the shared reviewed example packager."""
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from package_examples import build
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
build(args.out, Path(__file__).resolve().parent.name)
