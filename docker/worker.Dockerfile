FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    docker.io \
    git \
    openssh-client \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace

CMD ["bash"]
