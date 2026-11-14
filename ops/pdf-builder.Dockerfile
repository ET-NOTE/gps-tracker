# Builder for gps-pdf-render only. The API keeps its own pinned toolchain (ops/hub-builder.Dockerfile);
# the PDF processor is a separate static binary built with the toolchain its renderer needs.
FROM rust:1.92.0-bullseye
RUN rustup component add --toolchain 1.92.0 rustfmt clippy \
 && rustup target add --toolchain 1.92.0 x86_64-unknown-linux-musl
