FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global bun@1.3.13

WORKDIR /home/user/app
COPY --chown=node:node template/package.json ./package.json
RUN npm install --no-audit --no-fund
COPY --chown=node:node template/ ./
RUN chown node:node /home/user/app
USER node
RUN git init -b main \
  && git add -A \
  && git -c user.email=agent@vibe-vr.local -c user.name=Vibe-VR commit -m "Initial project"

EXPOSE 5173
CMD ["tail", "-f", "/dev/null"]
