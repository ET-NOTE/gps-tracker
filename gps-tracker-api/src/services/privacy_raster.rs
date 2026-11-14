//! Bounded, deterministic normalization of stored receipt rasters for reviewed disclosure.
//!
//! PNG/JPEG sources become opaque 8-bit RGB within 2048px per side and one megapixel.
//! Larger sources are reduced so memory follows the output, not the declared source size:
//! JPEG uses the decoder's DCT-domain scale and then exact integer area averaging; PNG rows
//! are streamed through the same averaging. JPEG EXIF orientation is applied. No other source
//! metadata survives. The same bytes always yield the same pixels, so a reviewer's selection
//! can be re-derived from the stored original at preview, issue and audit time.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, MutexGuard, TryLockError};

pub const MAX_SIDE: u32 = 2048;
pub const MAX_PIXELS: u64 = 1_000_000;
/// Declared source dimensions accepted for reduction. Beyond these nothing is decoded.
pub const MAX_SOURCE_SIDE: u32 = 16_384;
pub const MAX_JPEG_SOURCE_PIXELS: u64 = 64_000_000;
pub const MAX_PNG_SOURCE_PIXELS: u64 = 24_000_000;
/// Progressive JPEG keeps full-size coefficients (two bytes per sample) while decoding.
pub const MAX_PROGRESSIVE_PIXELS: u64 = 8_000_000;
/// Decoder output planes. A reduced decode stays below four times the final pixel count.
const MAX_DECODE_BYTES: usize = 13_000_000;
/// Bump when the pixel pipeline changes; older read proofs then stop matching.
pub const NORMALIZATION_VERSION: u8 = 2;
/// PDF pages drawn by the isolated renderer.
pub const PDF_NORMALIZATION_VERSION: u8 = 3;

#[derive(Debug, PartialEq, Eq)]
pub enum RasterError {
    /// Malformed, unsupported or inconsistent source.
    Invalid,
    /// Well-formed header, but outside the bounded reduction limits.
    TooLarge,
    /// Another large source is being reduced.
    Busy,
}
use RasterError::{Busy, Invalid, TooLarge};

pub struct Normalized {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
    /// Stored dimensions before reduction and orientation.
    pub source_width: u32,
    pub source_height: u32,
    /// EXIF orientation that was applied (1 = none).
    pub orientation: u8,
    /// Set when the pixels are one page of a PDF drawn by the isolated renderer.
    pub pdf: Option<PdfSource>,
}
pub struct PdfSource {
    /// 1-based page and the document's page count.
    pub page: u32,
    pub pages: u32,
    /// Page size as laid out, in thousandths of a point.
    pub page_width: u32,
    pub page_height: u32,
    /// The renderer build that produced the pixels.
    pub renderer_sha256: String,
}
impl Normalized {
    pub fn reduced(&self) -> bool {
        self.pdf.is_none()
            && u64::from(self.source_width) * u64::from(self.source_height)
                != u64::from(self.width) * u64::from(self.height)
    }
    /// Identifies the exact pixels a reviewer was shown, independent of PNG encoding.
    pub fn pixels_sha256(&self) -> String {
        let mut h = Sha256::new();
        match &self.pdf {
            // A separate domain: the same pixels on another page are another proof.
            Some(pdf) => {
                h.update([PDF_NORMALIZATION_VERSION]);
                h.update(pdf.page.to_be_bytes());
            }
            None => h.update([NORMALIZATION_VERSION]),
        }
        h.update(self.width.to_be_bytes());
        h.update(self.height.to_be_bytes());
        h.update(&self.rgb);
        format!("{:x}", h.finalize())
    }
    pub fn describe(&self) -> Value {
        if let Some(pdf) = &self.pdf {
            return json!({"version":PDF_NORMALIZATION_VERSION,"kind":"pdf","page":pdf.page,"pages":pdf.pages,"page_width_pt":f64::from(pdf.page_width)/1000.0,"page_height_pt":f64::from(pdf.page_height)/1000.0,"width":self.width,"height":self.height,"renderer_sha256":pdf.renderer_sha256});
        }
        json!({"version":NORMALIZATION_VERSION,"source_width":self.source_width,"source_height":self.source_height,"width":self.width,"height":self.height,"orientation":self.orientation,"reduced":self.reduced()})
    }
}

pub fn normalize(mime: &str, content: &[u8]) -> Result<Normalized, RasterError> {
    match mime {
        "image/jpeg" => decode_jpeg(content),
        "image/png" => decode_png(content),
        _ => Err(Invalid),
    }
}

/// Largest size inside both limits that keeps the aspect ratio; identity when already inside.
pub fn fit(w: u32, h: u32) -> (u32, u32) {
    let inside = |w: u32, h: u32| {
        w <= MAX_SIDE && h <= MAX_SIDE && u64::from(w) * u64::from(h) <= MAX_PIXELS
    };
    if w == 0 || h == 0 || inside(w, h) {
        return (w, h);
    }
    let (long, short) = if w >= h { (w, h) } else { (h, w) };
    let other = |l: u32| ((u64::from(l) * u64::from(short)) / u64::from(long)).max(1) as u32;
    let (mut lo, mut hi) = (1u32, long.min(MAX_SIDE));
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if inside(mid, other(mid)) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if w >= h {
        (lo, other(lo))
    } else {
        (other(lo), lo)
    }
}

fn source(w: u32, h: u32, max_pixels: u64) -> Result<(), RasterError> {
    if w == 0 || h == 0 {
        return Err(Invalid);
    }
    if w > MAX_SOURCE_SIDE || h > MAX_SOURCE_SIDE || u64::from(w) * u64::from(h) > max_pixels {
        return Err(TooLarge);
    }
    Ok(())
}

/// One large reduction at a time keeps peak memory predictable on the shared host.
fn large(wait: bool) -> Result<MutexGuard<'static, ()>, RasterError> {
    static LARGE: Mutex<()> = Mutex::new(());
    if wait {
        return Ok(LARGE.lock().unwrap_or_else(|e| e.into_inner()));
    }
    match LARGE.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::Poisoned(e)) => Ok(e.into_inner()),
        Err(TryLockError::WouldBlock) => Err(Busy),
    }
}

/// Exact integer area averaging, fed one opaque RGB row at a time.
struct Reducer {
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    row: usize,
    /// Per source column: first destination column and the share (of `dw`) it receives.
    columns: Vec<(u32, u32)>,
    line: Vec<u32>,
    acc: Vec<u64>,
    out: Vec<u8>,
}
impl Reducer {
    fn new(sw: u32, sh: u32, dw: u32, dh: u32) -> Self {
        let (sw, sh, dw, dh) = (sw as usize, sh as usize, dw as usize, dh as usize);
        let columns = (0..sw)
            .map(|x| {
                let start = x * dw;
                let j = start / sw;
                let first = (start + dw).min((j + 1) * sw) - start;
                (j as u32, first as u32)
            })
            .collect();
        Reducer {
            sw,
            sh,
            dw,
            dh,
            row: 0,
            columns,
            line: vec![0; dw * 3],
            acc: vec![0; dw * 3],
            out: Vec::with_capacity(dw * dh * 3),
        }
    }
    fn push(&mut self, rgb: &[u8]) {
        if rgb.len() != self.sw * 3 || self.row >= self.sh {
            self.row = usize::MAX; // finish() fails closed
            return;
        }
        self.line.fill(0);
        let dw = self.dw as u32;
        for (p, &(j, first)) in rgb.chunks_exact(3).zip(&self.columns) {
            let (j, rest) = (j as usize * 3, dw - first);
            for (c, &v) in p.iter().enumerate() {
                self.line[j + c] += u32::from(v) * first;
                if rest > 0 {
                    self.line[j + 3 + c] += u32::from(v) * rest;
                }
            }
        }
        let start = self.row * self.dh;
        let boundary = (start / self.sh + 1) * self.sh;
        let first = (start + self.dh).min(boundary) - start;
        for (a, &v) in self.acc.iter_mut().zip(&self.line) {
            *a += u64::from(v) * first as u64;
        }
        if start + first == boundary {
            let total = (self.sw * self.sh) as u64;
            let rest = (self.dh - first) as u64;
            for (a, &v) in self.acc.iter_mut().zip(&self.line) {
                self.out.push(((*a + total / 2) / total) as u8);
                *a = u64::from(v) * rest;
            }
        }
        self.row += 1;
    }
    fn finish(self) -> Result<Vec<u8>, RasterError> {
        if self.row == self.sh && self.out.len() == self.dw * self.dh * 3 {
            Ok(self.out)
        } else {
            Err(Invalid)
        }
    }
}

/// Composites 8-bit gray/RGB with optional alpha onto white.
fn flatten(data: &[u8], channels: usize, out: &mut [u8]) {
    for (p, o) in data.chunks_exact(channels).zip(out.chunks_exact_mut(3)) {
        let (c, a) = match channels {
            4 => ([p[0], p[1], p[2]], p[3]),
            3 => ([p[0], p[1], p[2]], 255),
            2 => ([p[0]; 3], p[1]),
            _ => ([p[0]; 3], 255),
        };
        for (o, v) in o.iter_mut().zip(c) {
            *o = ((u32::from(v) * u32::from(a) + 255 * (255 - u32::from(a)) + 127) / 255) as u8;
        }
    }
}

/// EXIF orientation (1..=8) from a TIFF block. Absent or malformed data means 1.
fn exif_orientation(tiff: &[u8]) -> u8 {
    let le = match tiff.get(..4) {
        Some(b"II*\0") => true,
        Some(b"MM\0*") => false,
        _ => return 1,
    };
    let bytes = |i: usize, n: usize| i.checked_add(n).and_then(|end| tiff.get(i..end));
    let u16_at = |i: usize| {
        bytes(i, 2).map(|b| {
            if le {
                u16::from_le_bytes([b[0], b[1]])
            } else {
                u16::from_be_bytes([b[0], b[1]])
            }
        })
    };
    let u32_at = |i: usize| {
        bytes(i, 4).map(|b| {
            if le {
                u32::from_le_bytes([b[0], b[1], b[2], b[3]])
            } else {
                u32::from_be_bytes([b[0], b[1], b[2], b[3]])
            }
        })
    };
    let Some(ifd) = u32_at(4).map(|v| v as usize) else {
        return 1;
    };
    let Some(count) = u16_at(ifd) else { return 1 };
    for i in 0..usize::from(count) {
        let Some(entry) = i.checked_mul(12).and_then(|o| o.checked_add(ifd + 2)) else {
            return 1;
        };
        match u16_at(entry) {
            Some(0x0112) => {
                return match (u16_at(entry + 2), u32_at(entry + 4), u16_at(entry + 8)) {
                    (Some(3), Some(1), Some(v @ 1..=8)) => v as u8,
                    _ => 1,
                }
            }
            Some(_) => {}
            None => return 1,
        }
    }
    1
}

/// Rearranges pixels so the image is upright for the given EXIF orientation.
fn orient(w: u32, h: u32, rgb: Vec<u8>, orientation: u8) -> (u32, u32, Vec<u8>) {
    if !(2..=8).contains(&orientation) {
        return (w, h, rgb);
    }
    let (w, h) = (w as usize, h as usize);
    let (dw, dh) = if orientation >= 5 { (h, w) } else { (w, h) };
    let mut out = vec![0u8; rgb.len()];
    for y in 0..dh {
        for x in 0..dw {
            let (sx, sy) = match orientation {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (y, h - 1 - x),
                7 => (w - 1 - y, h - 1 - x),
                _ => (w - 1 - y, x),
            };
            let (s, d) = ((sy * w + sx) * 3, (y * dw + x) * 3);
            out[d..d + 3].copy_from_slice(&rgb[s..s + 3]);
        }
    }
    (dw as u32, dh as u32, out)
}

fn decode_jpeg(content: &[u8]) -> Result<Normalized, RasterError> {
    use jpeg_decoder::{CodingProcess, Decoder, PixelFormat};
    let mut d = Decoder::new(content);
    d.set_max_decoding_buffer_size(MAX_DECODE_BYTES);
    d.read_info().map_err(|_| Invalid)?;
    // Before scale(): info() reports the output size once a scale is configured.
    let info = d.info().ok_or(Invalid)?;
    let (sw, sh) = (u32::from(info.width), u32::from(info.height));
    let channels = match info.pixel_format {
        PixelFormat::RGB24 => 3,
        PixelFormat::L8 => 1,
        _ => return Err(Invalid),
    };
    source(sw, sh, MAX_JPEG_SOURCE_PIXELS)?;
    let target = fit(sw, sh);
    let reduce = target != (sw, sh);
    if reduce {
        match info.coding_process {
            CodingProcess::DctSequential => {}
            CodingProcess::DctProgressive
                if u64::from(sw) * u64::from(sh) <= MAX_PROGRESSIVE_PIXELS => {}
            _ => return Err(TooLarge),
        }
    }
    let _guard = if reduce {
        Some(large(cfg!(test))?)
    } else {
        None
    };
    let (dw, dh) = if reduce {
        // Smallest of 1/8, 1/4, 1/2, 1 that still reaches the target; the rest is averaged.
        let (w, h) = d
            .scale(target.0 as u16, target.1 as u16)
            .map_err(|_| Invalid)?;
        (u32::from(w), u32::from(h))
    } else {
        (sw, sh)
    };
    let data = d.decode().map_err(|_| Invalid)?;
    let row = dw as usize * channels;
    if dw == 0 || dh == 0 || data.len() != row * dh as usize {
        return Err(Invalid);
    }
    let gray = |row: &[u8], line: &mut [u8]| {
        for (p, &v) in line.chunks_exact_mut(3).zip(row) {
            p.fill(v);
        }
    };
    let (fw, fh) = fit(dw, dh);
    let rgb = if (fw, fh) == (dw, dh) {
        if channels == 3 {
            data
        } else {
            let mut rgb = vec![0u8; data.len() * 3];
            gray(&data, &mut rgb);
            rgb
        }
    } else {
        let mut reducer = Reducer::new(dw, dh, fw, fh);
        let mut line = vec![0u8; dw as usize * 3];
        for source_row in data.chunks_exact(row) {
            if channels == 3 {
                reducer.push(source_row);
            } else {
                gray(source_row, &mut line);
                reducer.push(&line);
            }
        }
        reducer.finish()?
    };
    let orientation = d.exif_data().map_or(1, exif_orientation);
    let (width, height, rgb) = orient(fw, fh, rgb, orientation);
    Ok(Normalized {
        width,
        height,
        rgb,
        source_width: sw,
        source_height: sh,
        orientation,
        pdf: None,
    })
}

fn decode_png(content: &[u8]) -> Result<Normalized, RasterError> {
    use png::{BitDepth, ColorType, Transformations};
    let mut d = png::Decoder::new_with_limits(
        content,
        png::Limits {
            bytes: 16 * 1024 * 1024,
        },
    );
    d.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = d.read_info().map_err(|_| Invalid)?;
    let (sw, sh, animated, interlaced) = {
        let i = reader.info();
        (
            i.width,
            i.height,
            i.animation_control.is_some(),
            i.interlaced,
        )
    };
    source(sw, sh, MAX_PNG_SOURCE_PIXELS)?;
    if animated {
        return Err(Invalid);
    }
    let channels = match reader.output_color_type() {
        (ColorType::Rgb, BitDepth::Eight) => 3,
        (ColorType::Rgba, BitDepth::Eight) => 4,
        (ColorType::Grayscale, BitDepth::Eight) => 1,
        (ColorType::GrayscaleAlpha, BitDepth::Eight) => 2,
        _ => return Err(Invalid),
    };
    let (w, h) = (sw as usize, sh as usize);
    let (tw, th) = fit(sw, sh);
    let rgb = if (tw, th) == (sw, sh) {
        let size = reader.output_buffer_size();
        if size != w * h * channels {
            return Err(Invalid);
        }
        let mut buf = vec![0u8; size];
        let frame = reader.next_frame(&mut buf).map_err(|_| Invalid)?;
        if frame.buffer_size() != size {
            return Err(Invalid);
        }
        let mut rgb = vec![0u8; w * h * 3];
        flatten(&buf, channels, &mut rgb);
        rgb
    } else {
        // Adam7 rows arrive per pass and cannot be averaged in one bounded sweep.
        if interlaced {
            return Err(TooLarge);
        }
        let _guard = large(cfg!(test))?;
        let mut reducer = Reducer::new(sw, sh, tw, th);
        let mut line = vec![0u8; w * 3];
        for _ in 0..h {
            let row = reader.next_row().map_err(|_| Invalid)?.ok_or(Invalid)?;
            let data = row.data();
            if data.len() != w * channels {
                return Err(Invalid);
            }
            flatten(data, channels, &mut line);
            reducer.push(&line);
        }
        reducer.finish()?
    };
    Ok(Normalized {
        width: tw,
        height: th,
        rgb,
        source_width: sw,
        source_height: sh,
        orientation: 1,
        pdf: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bits {
        out: Vec<u8>,
        acc: u8,
        n: u8,
    }
    impl Bits {
        fn put(&mut self, code: u32, len: u8) {
            for i in (0..len).rev() {
                self.acc = (self.acc << 1) | ((code >> i) & 1) as u8;
                self.n += 1;
                if self.n == 8 {
                    self.out.push(self.acc);
                    if self.acc == 0xFF {
                        self.out.push(0);
                    }
                    self.acc = 0;
                    self.n = 0;
                }
            }
        }
        fn finish(mut self) -> Vec<u8> {
            while self.n != 0 {
                self.put(1, 1);
            }
            self.out
        }
    }
    /// Standard luminance DC codes by magnitude category.
    const DC: [(u32, u8); 12] = [
        (0b00, 2),
        (0b010, 3),
        (0b011, 3),
        (0b100, 3),
        (0b101, 3),
        (0b110, 3),
        (0b1110, 4),
        (0b11110, 5),
        (0b111110, 6),
        (0b1111110, 7),
        (0b11111110, 8),
        (0b111111110, 9),
    ];
    /// Minimal JPEG whose 8x8 blocks are flat: DC coefficients only, unit quantization.
    /// `block` returns one sample per component (gray, or YCbCr for three components).
    fn jpeg_fixture(
        w: u16,
        h: u16,
        components: usize,
        progressive: bool,
        orientation: Option<u16>,
        block: impl Fn(usize, usize) -> [u8; 3],
    ) -> Vec<u8> {
        let mut f = jpeg_header(w, h, components, progressive, orientation);
        let mut bits = Bits {
            out: Vec::new(),
            acc: 0,
            n: 0,
        };
        let mut previous = [0i32; 3];
        for by in 0..usize::from(h).div_ceil(8) {
            for bx in 0..usize::from(w).div_ceil(8) {
                let sample = block(bx, by);
                for c in 0..components {
                    let dc = 8 * (i32::from(sample[c]) - 128);
                    let diff = dc - previous[c];
                    previous[c] = dc;
                    let category = (32 - diff.unsigned_abs().leading_zeros()) as u8;
                    let (code, len) = DC[usize::from(category)];
                    bits.put(code, len);
                    if category > 0 {
                        let extra = if diff >= 0 {
                            diff
                        } else {
                            diff + (1 << category) - 1
                        };
                        bits.put(extra as u32, category);
                    }
                    if !progressive {
                        bits.put(0, 1); // end of block
                    }
                }
            }
        }
        f.extend(bits.finish());
        f.extend([0xFF, 0xD9]);
        f
    }
    fn jpeg_header(
        w: u16,
        h: u16,
        components: usize,
        progressive: bool,
        orientation: Option<u16>,
    ) -> Vec<u8> {
        let mut f = vec![0xFF, 0xD8];
        if let Some(o) = orientation {
            let mut t = b"Exif\0\0".to_vec();
            t.extend(exif(o, true));
            f.extend([0xFF, 0xE1]);
            f.extend(((t.len() + 2) as u16).to_be_bytes());
            f.extend(t);
        }
        f.extend([0xFF, 0xDB, 0, 67, 0]);
        f.extend([1u8; 64]);
        f.extend([0xFF, if progressive { 0xC2 } else { 0xC0 }]);
        f.extend(((8 + 3 * components) as u16).to_be_bytes());
        f.push(8);
        f.extend(h.to_be_bytes());
        f.extend(w.to_be_bytes());
        f.push(components as u8);
        for c in 0..components {
            f.extend([c as u8 + 1, 0x11, 0]);
        }
        f.extend([0xFF, 0xC4, 0, 31, 0x00]);
        f.extend([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
        f.extend(0u8..12);
        if !progressive {
            f.extend([0xFF, 0xC4, 0, 20, 0x10]);
            f.extend([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            f.push(0);
        }
        f.extend([0xFF, 0xDA]);
        f.extend(((6 + 2 * components) as u16).to_be_bytes());
        f.push(components as u8);
        for c in 0..components {
            f.extend([c as u8 + 1, 0x00]);
        }
        f.extend([0, if progressive { 0 } else { 63 }, 0]);
        f
    }
    fn exif(orientation: u16, le: bool) -> Vec<u8> {
        let u16b = |v: u16| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let u32b = |v: u32| if le { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut t = if le { b"II*\0" } else { b"MM\0*" }.to_vec();
        t.extend(u32b(8));
        t.extend(u16b(1));
        t.extend(u16b(0x0112));
        t.extend(u16b(3));
        t.extend(u32b(1));
        t.extend(u16b(orientation));
        t.extend([0, 0]);
        t.extend(u32b(0));
        t
    }
    fn crc(data: &[u8]) -> u32 {
        let mut c = !0u32;
        for &b in data {
            c ^= u32::from(b);
            for _ in 0..8 {
                c = if c & 1 == 1 {
                    (c >> 1) ^ 0xEDB8_8320
                } else {
                    c >> 1
                };
            }
        }
        !c
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut body = kind.to_vec();
        body.extend(data);
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend(&body);
        out.extend(crc(&body).to_be_bytes());
        out
    }
    /// Header-only PNG: enough for limits that must apply before any pixel is decoded.
    fn png_header(w: u32, h: u32, interlace: u8, extra: Vec<u8>) -> Vec<u8> {
        let mut ihdr = w.to_be_bytes().to_vec();
        ihdr.extend(h.to_be_bytes());
        ihdr.extend([8, 2, 0, 0, interlace]);
        let mut f = b"\x89PNG\r\n\x1a\n".to_vec();
        f.extend(chunk(b"IHDR", &ihdr));
        f.extend(extra);
        f.extend(chunk(b"IDAT", &[0x78, 0x9c]));
        f.extend(chunk(b"IEND", &[]));
        f
    }
    fn png_fixture(
        w: u32,
        h: u32,
        color: png::ColorType,
        depth: png::BitDepth,
        data: &[u8],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = png::Encoder::new(&mut out, w, h);
            e.set_color(color);
            e.set_depth(depth);
            e.write_header().unwrap().write_image_data(data).unwrap();
        }
        out
    }
    fn at(n: &Normalized, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * n.width + x) * 3) as usize;
        [n.rgb[i], n.rgb[i + 1], n.rgb[i + 2]]
    }
    fn near(a: [u8; 3], b: [u8; 3], tolerance: u8) -> bool {
        a.iter().zip(b).all(|(&a, b)| a.abs_diff(b) <= tolerance)
    }
    fn quadrants(bx: usize, by: usize) -> [u8; 3] {
        // 4000x3000 => 500x375 blocks.
        [match (bx < 250, by < 188) {
            (true, true) => 10,
            (false, true) => 80,
            (true, false) => 160,
            (false, false) => 240,
        }; 3]
    }

    #[test]
    fn fit_is_identity_inside_and_maximal_outside() {
        for size in [(1, 1), (1000, 1000), (2048, 488), (488, 2048), (640, 480)] {
            assert_eq!(fit(size.0, size.1), size);
        }
        assert_eq!(fit(4000, 3000), (1154, 865));
        assert_eq!(fit(3000, 4000), (865, 1154));
        assert_eq!(fit(2049, 1), (2048, 1));
        assert_eq!(fit(1, 16_384), (1, 2048));
        assert_eq!(fit(2048, 2048), (1000, 1000));
        assert_eq!(fit(0, 5), (0, 5));
        let mut seed = 0x2545_F491u32;
        for _ in 0..4000 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let (w, h) = (1 + seed % 16_384, 1 + (seed >> 14) % 16_384);
            let (tw, th) = fit(w, h);
            assert!(tw >= 1 && th >= 1 && tw <= w && th <= h, "{w}x{h}");
            assert!(
                tw <= MAX_SIDE && th <= MAX_SIDE && u64::from(tw) * u64::from(th) <= MAX_PIXELS
            );
            if (tw, th) != (w, h) {
                // The long side cannot grow by one pixel without leaving the limits.
                let (long, short) = (tw.max(th) + 1, w.min(h));
                let other = (u64::from(long) * u64::from(short) / u64::from(w.max(h))).max(1);
                assert!(
                    long > MAX_SIDE || u64::from(long) * other > MAX_PIXELS,
                    "{w}x{h}"
                );
            }
        }
    }

    #[test]
    fn reducer_averages_by_exact_area() {
        let mut r = Reducer::new(3, 1, 2, 1);
        r.push(&[0, 0, 0, 90, 90, 90, 180, 180, 180]);
        assert_eq!(r.finish().unwrap(), [30, 30, 30, 150, 150, 150]);
        let mut r = Reducer::new(2, 4, 1, 2);
        for row in [[0u8, 0, 0, 10, 20, 30], [20, 40, 60, 30, 60, 90]] {
            r.push(&row);
            r.push(&row);
        }
        assert_eq!(r.finish().unwrap(), [5, 10, 15, 25, 50, 75]);
        // Flat input stays flat for awkward ratios; missing or malformed rows fail closed.
        let mut r = Reducer::new(7, 5, 3, 2);
        for _ in 0..5 {
            r.push(&[201; 21]);
        }
        assert_eq!(r.finish().unwrap(), [201; 18]);
        let mut r = Reducer::new(7, 5, 3, 2);
        for _ in 0..4 {
            r.push(&[201; 21]);
        }
        assert_eq!(r.finish(), Err(Invalid));
        let mut r = Reducer::new(2, 1, 1, 1);
        r.push(&[1, 2, 3]);
        assert_eq!(r.finish(), Err(Invalid));
    }

    #[test]
    fn orientation_maps_every_exif_case() {
        // 2x3 image, pixel value = index in row-major order.
        let rgb: Vec<u8> = (0u8..6).flat_map(|v| [v; 3]).collect();
        let first = |o: u8| {
            let (w, h, out) = orient(2, 3, rgb.clone(), o);
            (w, h, out.chunks_exact(3).map(|p| p[0]).collect::<Vec<_>>())
        };
        assert_eq!(first(1), (2, 3, vec![0, 1, 2, 3, 4, 5]));
        assert_eq!(first(2), (2, 3, vec![1, 0, 3, 2, 5, 4]));
        assert_eq!(first(3), (2, 3, vec![5, 4, 3, 2, 1, 0]));
        assert_eq!(first(4), (2, 3, vec![4, 5, 2, 3, 0, 1]));
        assert_eq!(first(5), (3, 2, vec![0, 2, 4, 1, 3, 5]));
        assert_eq!(first(6), (3, 2, vec![4, 2, 0, 5, 3, 1]));
        assert_eq!(first(7), (3, 2, vec![5, 3, 1, 4, 2, 0]));
        assert_eq!(first(8), (3, 2, vec![1, 3, 5, 0, 2, 4]));
        assert_eq!(first(9), (2, 3, vec![0, 1, 2, 3, 4, 5]));
    }

    #[test]
    fn exif_orientation_is_bounded_and_defaults_to_upright() {
        for le in [true, false] {
            for o in 1..=8 {
                assert_eq!(exif_orientation(&exif(o, le)), o as u8);
            }
            assert_eq!(exif_orientation(&exif(0, le)), 1);
            assert_eq!(exif_orientation(&exif(9, le)), 1);
        }
        let good = exif(6, true);
        for cut in 0..good.len() {
            // Truncation never panics; the tag counts only once its value is fully present.
            let expected = if cut >= 20 { 6 } else { 1 };
            assert_eq!(exif_orientation(&good[..cut]), expected, "cut {cut}");
        }
        let mut wrong_type = good.clone();
        wrong_type[12] = 4;
        assert_eq!(exif_orientation(&wrong_type), 1);
        let mut far = good.clone();
        far[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(exif_orientation(&far), 1);
        assert_eq!(exif_orientation(b""), 1);
        assert_eq!(exif_orientation(b"XX*\0\x08\0\0\0"), 1);
    }

    #[test]
    fn small_jpeg_keeps_its_pixels_and_size() {
        let n = decode_jpeg(&jpeg_fixture(16, 8, 1, false, None, |bx, _| {
            [if bx == 0 { 40 } else { 200 }; 3]
        }))
        .unwrap();
        assert_eq!(
            (n.width, n.height, n.orientation, n.reduced()),
            (16, 8, 1, false)
        );
        assert!(near(at(&n, 0, 0), [40; 3], 1) && near(at(&n, 15, 7), [200; 3], 1));
        assert_eq!(n.describe()["reduced"], false);
    }

    #[test]
    fn large_jpeg_is_reduced_inside_limits_with_stable_pixels() {
        let file = jpeg_fixture(4000, 3000, 1, false, None, quadrants);
        assert!(file.len() < 5 * 1024 * 1024);
        let n = decode_jpeg(&file).unwrap();
        assert_eq!((n.width, n.height), (1154, 865));
        assert_eq!(
            (n.source_width, n.source_height, n.orientation),
            (4000, 3000, 1)
        );
        assert!(n.reduced() && n.rgb.len() == 1154 * 865 * 3);
        assert!(near(at(&n, 100, 100), [10; 3], 1));
        assert!(near(at(&n, 1000, 100), [80; 3], 1));
        assert!(near(at(&n, 100, 800), [160; 3], 1));
        assert!(near(at(&n, 1000, 800), [240; 3], 1));
        // Same bytes, same pixels: a selection can be re-derived later.
        let again = decode_jpeg(&file).unwrap();
        assert_eq!(n.pixels_sha256(), again.pixels_sha256());
        assert_eq!(n.describe(), again.describe());
    }

    #[test]
    fn exif_rotation_is_applied_after_reduction() {
        let n = decode_jpeg(&jpeg_fixture(4000, 3000, 1, false, Some(6), quadrants)).unwrap();
        assert_eq!((n.width, n.height, n.orientation), (865, 1154, 6));
        assert_eq!((n.source_width, n.source_height), (4000, 3000));
        // Rotated 90 degrees clockwise: stored bottom-left becomes the top-left.
        assert!(near(at(&n, 100, 100), [160; 3], 1));
        assert!(near(at(&n, 800, 100), [10; 3], 1));
        assert!(near(at(&n, 100, 1000), [240; 3], 1));
        assert!(near(at(&n, 800, 1000), [80; 3], 1));
        let upright = decode_jpeg(&jpeg_fixture(4000, 3000, 1, false, None, quadrants)).unwrap();
        assert_ne!(n.pixels_sha256(), upright.pixels_sha256());
        let small = decode_jpeg(&jpeg_fixture(16, 8, 1, false, Some(3), |bx, _| {
            [if bx == 0 { 40 } else { 200 }; 3]
        }))
        .unwrap();
        assert_eq!((small.width, small.height, small.orientation), (16, 8, 3));
        assert!(near(at(&small, 0, 0), [200; 3], 1) && near(at(&small, 15, 7), [40; 3], 1));
    }

    #[test]
    fn color_jpeg_reduces_with_color_conversion() {
        // YCbCr (128,128,255) is a saturated red-ish tone; (128,128,128) is mid gray.
        let n = decode_jpeg(&jpeg_fixture(2400, 1600, 3, false, None, |bx, _| {
            if bx < 150 {
                [128, 128, 255]
            } else {
                [128, 128, 128]
            }
        }))
        .unwrap();
        assert_eq!((n.width, n.height), fit(2400, 1600));
        assert!(
            near(at(&n, 100, 400), [255, 37, 128], 3),
            "{:?}",
            at(&n, 100, 400)
        );
        assert!(near(at(&n, 1100, 400), [128; 3], 3));
    }

    #[test]
    fn jpeg_limits_apply_before_decoding() {
        // Headers only: a bounded reduction must refuse these without touching entropy data.
        let header = |w, h, progressive| {
            let mut f = jpeg_header(w, h, 1, progressive, None);
            f.extend([0xFF, 0xD9]);
            f
        };
        assert_eq!(
            decode_jpeg(&header(65_535, 65_535, false)).err(),
            Some(TooLarge)
        );
        assert_eq!(decode_jpeg(&header(16_385, 8, false)).err(), Some(TooLarge));
        assert_eq!(
            decode_jpeg(&header(9000, 8000, false)).err(),
            Some(TooLarge)
        );
        assert_eq!(decode_jpeg(&header(4000, 3000, true)).err(), Some(TooLarge));
        assert_eq!(decode_jpeg(b"\xFF\xD8\xFF").err(), Some(Invalid));
        // Four components (CMYK) are not converted.
        let mut cmyk = jpeg_header(8, 8, 4, false, None);
        cmyk.extend([0xFF, 0xD9]);
        assert_eq!(decode_jpeg(&cmyk).err(), Some(Invalid));
        // The declared-size boundary itself.
        assert_eq!(source(8000, 8000, MAX_JPEG_SOURCE_PIXELS), Ok(()));
        assert_eq!(source(8001, 8000, MAX_JPEG_SOURCE_PIXELS), Err(TooLarge));
        assert_eq!(source(16_384, 1, MAX_JPEG_SOURCE_PIXELS), Ok(()));
        assert_eq!(source(0, 1, MAX_JPEG_SOURCE_PIXELS), Err(Invalid));
        // Progressive is accepted below its coefficient-memory bound and reduced.
        let n = decode_jpeg(&jpeg_fixture(2400, 1600, 1, true, None, |_, _| [90; 3])).unwrap();
        assert_eq!((n.width, n.height), fit(2400, 1600));
        assert!(near(at(&n, 600, 400), [90; 3], 1));
    }

    #[test]
    fn large_png_streams_rows_and_flattens_alpha() {
        let (w, h) = (2100u32, 1000u32);
        let mut data = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..h {
            for x in 0..w {
                data.extend(if x < 1050 {
                    [255, 0, 0, 255]
                } else {
                    [9, 8, 7, 0]
                });
            }
        }
        let file = png_fixture(w, h, png::ColorType::Rgba, png::BitDepth::Eight, &data);
        let n = decode_png(&file).unwrap();
        assert_eq!((n.width, n.height), fit(w, h));
        assert_eq!((n.source_width, n.source_height, n.orientation), (w, h, 1));
        assert!(n.reduced());
        assert_eq!(at(&n, 10, 10), [255, 0, 0]);
        assert_eq!(at(&n, n.width - 10, n.height - 10), [255, 255, 255]);
        assert_eq!(
            n.pixels_sha256(),
            decode_png(&file).unwrap().pixels_sha256()
        );
    }

    #[test]
    fn small_png_variants_decode_directly() {
        let n = decode_png(&png_fixture(
            2,
            1,
            png::ColorType::Rgba,
            png::BitDepth::Eight,
            &[9, 8, 7, 0, 255, 0, 0, 128],
        ))
        .unwrap();
        assert_eq!((n.width, n.height, n.reduced()), (2, 1, false));
        assert_eq!(n.rgb, [255, 255, 255, 255, 127, 127]);
        let n = decode_png(&png_fixture(
            1,
            1,
            png::ColorType::Rgb,
            png::BitDepth::Sixteen,
            &[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc],
        ))
        .unwrap();
        assert_eq!(n.rgb, [0x12, 0x56, 0x9a]);
        let n = decode_png(&png_fixture(
            2,
            1,
            png::ColorType::GrayscaleAlpha,
            png::BitDepth::Eight,
            &[100, 255, 0, 0],
        ))
        .unwrap();
        assert_eq!(n.rgb, [100, 100, 100, 255, 255, 255]);
    }

    #[test]
    fn png_limits_apply_before_decoding() {
        assert_eq!(
            decode_png(&png_header(16_385, 1, 0, vec![])).err(),
            Some(TooLarge)
        );
        assert_eq!(
            decode_png(&png_header(6000, 5000, 0, vec![])).err(),
            Some(TooLarge)
        );
        assert_eq!(
            decode_png(&png_header(3000, 2000, 1, vec![])).err(),
            Some(TooLarge)
        );
        let actl = chunk(b"acTL", &[0, 0, 0, 1, 0, 0, 0, 0]);
        assert_eq!(decode_png(&png_header(2, 1, 0, actl)).err(), Some(Invalid));
        // Truncated pixel data is malformed whether or not a reduction is needed.
        assert_eq!(
            decode_png(&png_header(2, 1, 0, vec![])).err(),
            Some(Invalid)
        );
        assert_eq!(
            decode_png(&png_header(3000, 2000, 0, vec![])).err(),
            Some(Invalid)
        );
        assert_eq!(decode_png(b"\x89PNG\r\n\x1a\nBAD").err(), Some(Invalid));
        assert_eq!(normalize("image/webp", b"RIFF").err(), Some(Invalid));
        assert_eq!(
            normalize("application/pdf", b"%PDF-1.7").err(),
            Some(Invalid)
        );
    }

    #[test]
    fn pdf_pages_have_their_own_proof_domain_and_description() {
        let page = |number| Normalized {
            width: 2,
            height: 1,
            rgb: vec![1, 2, 3, 4, 5, 6],
            source_width: 0,
            source_height: 0,
            orientation: 1,
            pdf: Some(PdfSource {
                page: number,
                pages: 5,
                page_width: 595_276,
                page_height: 841_890,
                renderer_sha256: "ab".repeat(32),
            }),
        };
        let image = Normalized {
            pdf: None,
            source_width: 2,
            source_height: 1,
            ..page(1)
        };
        // Same pixels: an image, page 1 and page 2 are three different proofs.
        assert_ne!(page(1).pixels_sha256(), page(2).pixels_sha256());
        assert_ne!(page(1).pixels_sha256(), image.pixels_sha256());
        assert_eq!(page(2).pixels_sha256(), page(2).pixels_sha256());
        assert!(!page(1).reduced());
        let described = page(2).describe();
        assert_eq!(described["kind"], "pdf");
        assert_eq!(
            (described["page"].as_u64(), described["pages"].as_u64()),
            (Some(2), Some(5))
        );
        assert_eq!(described["page_width_pt"].as_f64(), Some(595.276));
        assert_eq!(described["version"], 3);
        assert!(described.get("orientation").is_none() && image.describe().get("kind").is_none());
    }

    #[test]
    fn one_large_reduction_at_a_time() {
        // Other tests wait for this lock, so only the refusal while held is asserted.
        let held = large(true).unwrap();
        assert_eq!(large(false).err(), Some(Busy));
        drop(held);
    }
}
