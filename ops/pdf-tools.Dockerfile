# Build-host test tools for the PDF processor. Never deployed and never used to produce a delivery:
# poppler is only the reference renderer for quality comparison, qpdf/libtiff only build test documents.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils qpdf libtiff-tools fonts-nanum python3 python3-pil strace time \
 && rm -rf /var/lib/apt/lists/*
