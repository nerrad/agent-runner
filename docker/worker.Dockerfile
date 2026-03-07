FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    composer \
    curl \
    docker.io \
    git \
    openssh-client \
    php-cli \
    php-curl \
    php-mbstring \
    php-xml \
    php-zip \
    python-is-python3 \
    python3 \
    python3-pip \
    ripgrep \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace

CMD ["bash"]
