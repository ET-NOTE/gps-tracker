//! One page of one PDF as opaque RGB inside the delivery limits.
use crate::protocol::{Page, Request, Status};
use hayro::hayro_interpret::font::FontQuery;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::{LoadPdfError, Pdf};
use hayro::kurbo::Affine;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{Pixmap, RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{render_into, RenderCache, RenderSettings};
use std::sync::Arc;

pub const MAX_PAGES: usize = 200;
/// Same delivery limits as normalized images.
pub const MAX_SIDE: u32 = 2048;
pub const MAX_PIXELS: u64 = 1_000_000;
/// 200 inches, the largest page the format defines.
const MAX_POINTS: f32 = 14_400.0;

// Korean fallback for fonts a PDF names but does not embed. Embedded fonts are always used as-is.
static KOREAN: &[u8] =
    include_bytes!("../../gps-tracker-web/src/assets/fonts/NanumGothic-Regular.ttf");
static KOREAN_BOLD: &[u8] =
    include_bytes!("../../gps-tracker-web/src/assets/fonts/NanumGothic-Bold.ttf");

/// Largest pixel size inside both limits for a page of `w` x `h` points. A page is vector
/// content, so unlike a stored photo it is drawn directly at this size.
pub fn target(w: f32, h: f32) -> (u32, u32) {
    let (w, h) = (f64::from(w), f64::from(h));
    let scale = (f64::from(MAX_SIDE) / w.max(h)).min((MAX_PIXELS as f64 / (w * h)).sqrt());
    let mut width = ((w * scale).floor() as u32).clamp(1, MAX_SIDE);
    let mut height = ((h * scale).floor() as u32).clamp(1, MAX_SIDE);
    // Floating point may land one pixel over; the limit is exact.
    while u64::from(width) * u64::from(height) > MAX_PIXELS {
        if width >= height {
            width -= 1;
        } else {
            height -= 1;
        }
    }
    (width, height)
}

fn settings() -> InterpreterSettings {
    InterpreterSettings {
        font_resolver: Arc::new(|query| match query {
            FontQuery::Standard(font) => Some(font.get_font_data()),
            FontQuery::Fallback(font) => {
                if font.character_collection.is_some() {
                    // A CID font without its font file: almost always CJK text.
                    let data: &'static [u8] = if font.is_bold { KOREAN_BOLD } else { KOREAN };
                    Some((Arc::new(data), 0))
                } else {
                    Some(font.pick_standard_font().get_font_data())
                }
            }
        }),
        ..Default::default()
    }
}

pub fn page(request: &Request) -> Result<Page, Status> {
    // A password that cannot be right: an unencrypted file ignores it, an encrypted one fails,
    // including files that only carry an owner password and would open with an empty one.
    let pdf = match Pdf::new_with_password(request.pdf.clone(), "\u{1}not-a-password\u{1}") {
        Ok(pdf) => pdf,
        Err(LoadPdfError::Decryption(_)) => return Err(Status::Encrypted),
        Err(_) => return Err(Status::Invalid),
    };
    let pages = pdf.pages();
    if pages.is_empty() {
        return Err(Status::Invalid);
    }
    if pages.len() > MAX_PAGES {
        return Err(Status::TooManyPages);
    }
    let page = pages
        .get(request.page as usize - 1)
        .ok_or(Status::NoSuchPage)?;
    let (w, h) = page.render_dimensions();
    if !(w.is_finite()
        && h.is_finite()
        && (1.0..=MAX_POINTS).contains(&w)
        && (1.0..=MAX_POINTS).contains(&h))
    {
        return Err(Status::PageSize);
    }
    let (width, height) = target(w, h);
    let mut context = RenderContext::new(width as u16, height as u16);
    let transform = Affine::scale_non_uniform(
        f64::from(width) / f64::from(w),
        f64::from(height) / f64::from(h),
    ) * page.initial_transform(true).to_kurbo();
    let cache = RenderCache::new();
    render_into(
        page,
        &cache,
        &settings(),
        &RenderSettings::default(),
        &mut context,
        transform,
    );
    context.flush();
    let mut pixmap = Pixmap::new(width as u16, height as u16);
    context.render_with(
        &mut pixmap,
        &mut Resources::default(),
        RasterizerSettings {
            target_init: TargetInit::Clear(WHITE),
            ..Default::default()
        },
    );
    let rgba = pixmap.data_as_u8_slice();
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(Status::Failed);
    }
    // Premultiplied over white: opaque pixels pass through, anything else is flattened.
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        let rest = 255 - pixel[3];
        rgb.extend(pixel[..3].iter().map(|&c| c.saturating_add(rest)));
    }
    Ok(Page {
        width,
        height,
        pages: pages.len() as u32,
        page_width: (f64::from(w) * 1000.0).round() as u32,
        page_height: (f64::from(h) * 1000.0).round() as u32,
        rgb,
    })
}

/// A two-page document made here: page 1 is 200x100pt with its left half red, page 2 is blank.
pub fn sample() -> Vec<u8> {
    let content = "1 0 0 rg 0 0 100 100 re f";
    let objects = [
        "<</Type/Catalog/Pages 2 0 R>>".to_string(),
        "<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>".to_string(),
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>".to_string(),
        format!("<</Length {}>>stream\n{content}\nendstream", content.len()),
        "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>".to_string(),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj{object}endobj\n", index + 1).bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        pdf.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    pdf.extend(
        format!(
            "trailer<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    pdf
}

/// Used by the self-test: the built-in page must come out with the expected pixels.
pub fn sample_renders() -> bool {
    let Ok(page) = page(&Request {
        page: 1,
        pdf: sample(),
    }) else {
        return false;
    };
    let at = |x: u32, y: u32| {
        let i = ((y * page.width + x) * 3) as usize;
        [page.rgb[i], page.rgb[i + 1], page.rgb[i + 2]]
    };
    (page.width, page.height, page.pages) == (1414, 707, 2)
        && at(100, 100) == [255, 0, 0]
        && at(1300, 100) == [255, 255, 255]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_fills_the_limits_without_exceeding_them() {
        assert_eq!(target(200.0, 100.0), (1414, 707));
        let (w, h) = target(595.276, 841.89); // A4
        assert!(
            (839..=841).contains(&w) && (1187..=1190).contains(&h),
            "{w}x{h}"
        );
        assert_eq!(target(1.0, 14_400.0), (1, 2048));
        assert_eq!(target(14_400.0, 1.0), (2048, 1));
        let mut seed = 0x2545_F491u32;
        for _ in 0..4000 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let (pw, ph) = (
                1.0 + (seed % 14_399) as f32,
                1.0 + ((seed >> 14) % 14_399) as f32,
            );
            let (w, h) = target(pw, ph);
            assert!(
                (1..=MAX_SIDE).contains(&w) && (1..=MAX_SIDE).contains(&h),
                "{pw}x{ph}"
            );
            assert!(u64::from(w) * u64::from(h) <= MAX_PIXELS, "{pw}x{ph}");
        }
    }

    #[test]
    fn built_in_page_renders_with_exact_pixels() {
        assert!(sample_renders());
        let second = page(&Request {
            page: 2,
            pdf: sample(),
        })
        .unwrap();
        assert_eq!((second.width, second.height, second.pages), (1000, 1000, 2));
        assert_eq!((second.page_width, second.page_height), (300_000, 300_000));
        assert!(second.rgb.iter().all(|&v| v == 255));
    }

    #[test]
    fn unreadable_documents_and_missing_pages_are_refused() {
        let status = |page_number, pdf: Vec<u8>| {
            page(&Request {
                page: page_number,
                pdf,
            })
            .err()
        };
        assert_eq!(status(3, sample()), Some(Status::NoSuchPage));
        assert_eq!(
            status(1, b"%PDF-1.7\nnot a document".to_vec()),
            Some(Status::Invalid)
        );
        assert_eq!(status(1, b"plain text".to_vec()), Some(Status::Invalid));
        let mut huge = String::from_utf8(sample()).unwrap();
        huge = huge.replace("[0 0 200 100]", "[0 0 20000 100]");
        assert_eq!(status(1, huge.into_bytes()), Some(Status::PageSize));
    }
}
