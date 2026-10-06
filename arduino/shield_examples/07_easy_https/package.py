"""Compatibility entry point for the shared reviewed example packager."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from package_examples import build
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
manifest = build(args.out, Path(__file__).resolve().parent.name)
# Keep the single-lesson publication format used by the original publisher.
(args.out / 'publication.json').write_text(json.dumps(manifest[0], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
