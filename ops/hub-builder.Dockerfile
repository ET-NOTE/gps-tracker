FROM rust:1.88.0-bullseye
RUN rustup component add --toolchain 1.88.0 rustfmt clippy
RUN set -eu; cd /tmp; \
    curl -fsSLO https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz; \
    curl -fsSLO https://nodejs.org/dist/v22.22.2/SHASUMS256.txt; \
    grep ' node-v22.22.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -; \
    tar -xJf node-v22.22.2-linux-x64.tar.xz -C /usr/local --strip-components=1; \
    rm node-v22.22.2-linux-x64.tar.xz SHASUMS256.txt
