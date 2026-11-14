FROM gps-runtime119:20261112
COPY packages/*.deb /tmp/gps121-packages/
RUN echo '793f2ac03d48568c2a81646778563fbdddf9e21bccebcea0a10423003389e007  /tmp/gps121-packages/timescaledb.deb' | sha256sum -c - \
 && echo 'b0aafee554990fff52d9b4344f1dcb0498e9da30d9313b8e511bab1ec47f0f5a  /tmp/gps121-packages/timescaledb-loader.deb' | sha256sum -c - \
 && dpkg -i /tmp/gps121-packages/*.deb \
 && rm /tmp/gps121-packages/*.deb
# Internal rehearsal only. Host ports and production credentials are not used.
