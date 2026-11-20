"""Renderer evaluation (build-host tools container): every corpus file through gps-pdf-render,
compared with poppler as the reference for quality, plus time and peak memory.
"""
import json, pathlib, struct, subprocess, sys, time
from PIL import Image, ImageChops, ImageStat

binary, corpus, out = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
MAGIC = b'GPSPDF1\n'
STATUS = ['ok', 'bad_request', 'invalid', 'encrypted', 'too_many_pages', 'no_such_page', 'page_size', 'failed']


def render(pdf, page=1, timeout=30):
    request = MAGIC + struct.pack('>II', page, len(pdf)) + pdf
    started = time.monotonic()
    try:
        # GNU time reports the peak resident memory of this one run on the last stderr line.
        done = subprocess.run(['/usr/bin/time', '-f', '%M', binary], input=request, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {'outcome': 'timeout', 'seconds': round(time.monotonic() - started, 2)}
    notes = done.stderr.decode(errors='replace').strip().splitlines()
    result = {'seconds': round(time.monotonic() - started, 3), 'peak_rss_mb': round(int(notes[-1]) / 1024, 1) if notes and notes[-1].isdigit() else None, 'exit': done.returncode}
    reply = done.stdout
    if done.returncode != 0 or reply[:8] != MAGIC or len(reply) < 12:
        result['outcome'] = 'no reply: ' + '; '.join(notes[:-1] or [f'exit {done.returncode}'])
        return result
    status = struct.unpack('>I', reply[8:12])[0]
    result['outcome'] = STATUS[status] if status < len(STATUS) else f'status {status}'
    if status == 0:
        width, height, pages, page_w, page_h = struct.unpack('>5I', reply[12:32])
        assert len(reply) == 32 + width * height * 3, 'reply length'
        result.update(width=width, height=height, pages=pages, page_points=[page_w / 1000, page_h / 1000], image=Image.frombytes('RGB', (width, height), reply[32:]))
    return result


def reference(path, page, size, timeout=60):
    prefix = out / 'reference'
    started = time.monotonic()
    done = subprocess.run(['/usr/bin/time', '-f', '%M', 'pdftoppm', '-f', str(page), '-l', str(page), '-scale-to-x', str(size[0]), '-scale-to-y', str(size[1]), '-png', '-singlefile', str(path), str(prefix)], capture_output=True, timeout=timeout)
    seconds = time.monotonic() - started
    image = prefix.with_suffix('.png')
    if done.returncode != 0 or not image.exists():
        return None, seconds, None
    loaded = Image.open(image).convert('RGB')
    loaded.load()
    image.unlink()
    return loaded, seconds, int(done.stderr.decode().strip().splitlines()[-1]) / 1024


report = []
for path in sorted(corpus.glob('*.pdf')):
    pdf = path.read_bytes()
    pages = [1]
    first = render(pdf)
    if first['outcome'] == 'ok' and first['pages'] > 1 and not path.name.startswith('limit-'):
        pages = [1, first['pages']]
    for page in pages:
        result = first if page == 1 else render(pdf, page)
        row = {'file': path.name, 'bytes': len(pdf), 'page': page, **{k: v for k, v in result.items() if k != 'image'}}
        if 'image' in result:
            image = result['image']
            image.save(out / f'{path.stem}-p{page}.png')
            expected, seconds, memory = reference(path, page, image.size)
            if expected is not None and expected.size == image.size:
                expected.save(out / f'{path.stem}-p{page}-reference.png')
                difference = ImageChops.difference(image.convert('L'), expected.convert('L'))
                histogram = difference.histogram()
                total = image.size[0] * image.size[1]
                row.update(reference_seconds=round(seconds, 3), reference_peak_rss_mb=round(memory, 1), mean_abs_difference=round(ImageStat.Stat(difference).mean[0], 2),
                           pixels_differing_over_64_percent=round(100 * sum(histogram[65:]) / total, 2), ink_percent=round(100 * sum(image.convert('L').histogram()[:128]) / total, 2),
                           reference_ink_percent=round(100 * sum(expected.convert('L').histogram()[:128]) / total, 2))
            else:
                row['reference'] = 'not rendered'
        report.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
(out / 'evaluation.json').write_text(json.dumps(report, indent=1, ensure_ascii=False))
