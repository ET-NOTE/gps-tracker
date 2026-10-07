// ─── GPX / CSV export ────────────────────────────────────
export function exportGpx(points, filename) {
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="seriallog-gps" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${filename.replace(/\.gpx$/, '')}</name><trkseg>
`;
  const body = points.map(p => {
    const speed = p._speed != null ? `<speed>${(p._speed / 3.6).toFixed(2)}</speed>` : '';
    return `    <trkpt lat="${p.lat}" lon="${p.lng}"><time>${p.recorded_at}</time>${speed}</trkpt>`;
  }).join('\n');
  const tail = `\n  </trkseg></trk>\n</gpx>\n`;
  download(filename, head + body + tail, 'application/gpx+xml');
}
export function exportCsv(points, filename) {
  const header = 'timestamp,lat,lng,speed_kmh,is_stop,sat,vbat_mv\n';
  const body = points.map(p => [
    p.recorded_at,
    p.lat,
    p.lng,
    p._speed != null ? p._speed.toFixed(2) : '',
    p._isStop ? '1' : '0',
    p.sat ?? '',
    p.vbat_mv ?? '',
  ].join(',')).join('\n');
  download(filename, header + body + '\n', 'text/csv;charset=utf-8');
}
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

