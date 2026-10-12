FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# git + certs for npm/husky; sudo so postCreateCommand can chown the
# node_modules volume; the rest are the shared libraries + xvfb that
# @vscode/test-electron needs to launch VS Code for `npm run test:integration`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    sudo \
    xvfb \
    xauth \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libdrm2 \
    libasound2 \
    libdbus-1-3 \
    libxkbfile1 \
    libsecret-1-0 \
    libxss1 \
  && rm -rf /var/lib/apt/lists/* \
  && echo "node ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

USER node
WORKDIR /workspace
