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
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm config set store-dir /root/.local/share/pnpm/store --global
RUN npm install -g @anthropic-ai/claude-code @openai/codex
COPY docker/worker-bin/ /usr/local/bin/
RUN chmod +x /usr/local/bin/ar-*
RUN mkdir -p /home/agent-runner && chmod 0777 /home/agent-runner
COPY docker/worker-bin/ar-emit /usr/local/bin/ar-emit
RUN chmod 0755 /usr/local/bin/ar-emit

WORKDIR /workspace

CMD ["bash"]
