//! Wire format between the API and this process. Fixed-size big-endian fields, no parsing
//! beyond lengths, so neither side has to trust the other's formatting.
//!
//! Request:  MAGIC, page (u32, 1-based), length (u32), PDF bytes.
//! Reply:    MAGIC, status (u32). When the status is OK: width, height, page count,
//!           page width and height in thousandths of a point (u32 each), then width*height*3 RGB.
use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 8] = b"GPSPDF1\n";
/// Same ceiling as a stored receipt.
pub const MAX_PDF: usize = 5 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Status {
    Ok = 0,
    /// The request itself is malformed.
    BadRequest = 1,
    /// Not a readable PDF.
    Invalid = 2,
    /// Encrypted, with or without a user password.
    Encrypted = 3,
    TooManyPages = 4,
    NoSuchPage = 5,
    /// Page dimensions outside what a page can be.
    PageSize = 6,
    /// The renderer gave up on this page.
    Failed = 7,
    /// The shared service already has a live worker; no document was read.
    Busy = 8,
}

pub struct Request {
    pub page: u32,
    pub pdf: Vec<u8>,
}

pub struct Page {
    pub width: u32,
    pub height: u32,
    pub pages: u32,
    /// Page size as laid out (after rotation and crop), in thousandths of a point.
    pub page_width: u32,
    pub page_height: u32,
    pub rgb: Vec<u8>,
}

fn word(source: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    source.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}

impl Request {
    pub fn read(source: &mut impl Read) -> Result<Self, Status> {
        let mut magic = [0u8; 8];
        source
            .read_exact(&mut magic)
            .map_err(|_| Status::BadRequest)?;
        if &magic != MAGIC {
            return Err(Status::BadRequest);
        }
        let page = word(source).map_err(|_| Status::BadRequest)?;
        let length = word(source).map_err(|_| Status::BadRequest)? as usize;
        if page == 0 || length == 0 || length > MAX_PDF {
            return Err(Status::BadRequest);
        }
        let mut pdf = vec![0u8; length];
        source
            .read_exact(&mut pdf)
            .map_err(|_| Status::BadRequest)?;
        // Anything after the declared length is not part of the contract.
        let mut extra = [0u8; 1];
        if source.read(&mut extra).map_err(|_| Status::BadRequest)? != 0 {
            return Err(Status::BadRequest);
        }
        Ok(Request { page, pdf })
    }
}

pub fn reply(target: &mut impl Write, outcome: &Result<Page, Status>) -> io::Result<()> {
    target.write_all(MAGIC)?;
    match outcome {
        Err(status) => target.write_all(&(*status as u32).to_be_bytes())?,
        Ok(page) => {
            for value in [
                Status::Ok as u32,
                page.width,
                page.height,
                page.pages,
                page.page_width,
                page.page_height,
            ] {
                target.write_all(&value.to_be_bytes())?;
            }
            target.write_all(&page.rgb)?;
        }
    }
    target.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(page: u32, length: u32, body: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend(page.to_be_bytes());
        bytes.extend(length.to_be_bytes());
        bytes.extend(body);
        bytes
    }

    #[test]
    fn request_is_exactly_what_was_declared() {
        let ok = Request::read(&mut request(2, 4, b"%PDF").as_slice()).unwrap();
        assert_eq!((ok.page, ok.pdf.as_slice()), (2, b"%PDF".as_slice()));
        for bad in [
            request(0, 4, b"%PDF"),                  // pages start at 1
            request(1, 0, b""),                      // empty document
            request(1, 5, b"%PDF"),                  // shorter than declared
            request(1, 4, b"%PDF!"),                 // longer than declared
            request(1, MAX_PDF as u32 + 1, b"%PDF"), // refused before reading the body
            b"GPSPDF2\n\0\0\0\x01\0\0\0\x04%PDF".to_vec(),
            MAGIC[..5].to_vec(),
            Vec::new(),
        ] {
            assert_eq!(
                Request::read(&mut bad.as_slice()).err(),
                Some(Status::BadRequest)
            );
        }
    }

    #[test]
    fn reply_layout_is_fixed() {
        let mut out = Vec::new();
        reply(&mut out, &Err(Status::Encrypted)).unwrap();
        assert_eq!(out, [MAGIC.as_slice(), &3u32.to_be_bytes()].concat());
        let page = Page {
            width: 2,
            height: 1,
            pages: 7,
            page_width: 595_276,
            page_height: 841_890,
            rgb: vec![1, 2, 3, 4, 5, 6],
        };
        let mut out = Vec::new();
        reply(&mut out, &Ok(page)).unwrap();
        assert_eq!(out.len(), 8 + 6 * 4 + 6);
        assert_eq!(&out[8..12], &0u32.to_be_bytes());
        assert_eq!(&out[12..16], &2u32.to_be_bytes());
        assert_eq!(&out[20..24], &7u32.to_be_bytes());
        assert_eq!(&out[32..], &[1, 2, 3, 4, 5, 6]);
    }
}
