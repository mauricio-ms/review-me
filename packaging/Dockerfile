# Build review-me for Ubuntu, on Ubuntu.
#
# A binary built on this repo's usual host (Arch, glibc 2.43) will not start on
# Ubuntu — the loader rejects it long before webkit2gtk matters. Building on the
# OLDEST Ubuntu we care about produces a package that also installs on newer
# ones, because glibc is backward compatible but not forward compatible.
ARG UBUNTU_VERSION=22.04
FROM ubuntu:${UBUNTU_VERSION}

ARG NODE_VERSION=20.18.1
ARG RUST_VERSION=stable
ENV DEBIAN_FRONTEND=noninteractive

# Tauri v2's Linux dependencies (webkit2gtk 4.1, not the 4.0 of Tauri v1) plus
# what the .deb/AppImage bundlers shell out to.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      file \
      git \
      libayatana-appindicator3-dev \
      libgtk-3-dev \
      libjavascriptcoregtk-4.1-dev \
      librsvg2-dev \
      libsoup-3.0-dev \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libxdo-dev \
      patchelf \
      pkg-config \
      squashfs-tools \
      desktop-file-utils \
      fakeroot \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"

WORKDIR /src

# Dependency layers first, so editing source doesn't re-fetch the world.
COPY package.json package-lock.json ./
RUN npm ci

COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./src-tauri/
# Cargo refuses to parse a manifest whose [lib]/[[bin]] targets don't exist, so
# stub them out purely to make `fetch` resolvable; `COPY . .` replaces them.
RUN mkdir -p src-tauri/src \
    && touch src-tauri/src/lib.rs \
    && echo 'fn main() {}' > src-tauri/src/main.rs \
    && cargo fetch --manifest-path src-tauri/Cargo.toml \
    && rm -rf src-tauri/src

COPY . .

# linuxdeploy (the AppImage bundler) runs its own AppImages, which want FUSE —
# unavailable in an unprivileged container. This makes them self-extract instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1
# --bundles is supplied by the build script; tauri.conf.json's "all" would also
# try targets that need extra tooling.
ENTRYPOINT ["npm", "run", "tauri", "build", "--"]
