# strfry, built from source.
#
# Built rather than pulled from a registry because strfry publishes no official
# image - pinning to a third-party mirror would mean trusting whoever owns that
# tag with the room's history.
#
# Node is installed alongside it to run write-policy.js, which is what keeps junk
# out of your relay's disk.

FROM ubuntu:24.04 AS build

ARG STRFRY_REF=1.1.3

RUN apt-get update && apt-get install -y --no-install-recommends \
      git g++ make pkg-config libtool ca-certificates \
      libyaml-perl libtemplate-perl libregexp-grammars-perl libssl-dev zlib1g-dev \
      liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone https://github.com/hoytech/strfry.git . \
    && git checkout "${STRFRY_REF}" \
    && git submodule update --init \
    && make setup-golpe \
    && make -j"$(nproc)"

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates nodejs \
      liblmdb0 libflatbuffers-dev libsecp256k1-1 libzstd1 libssl3t64 zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/strfry /app/strfry
COPY strfry.conf /etc/strfry.conf
COPY write-policy.js /app/write-policy.js

RUN mkdir -p /app/strfry-db
WORKDIR /app

EXPOSE 7777
CMD ["/app/strfry", "--config=/etc/strfry.conf", "relay"]
