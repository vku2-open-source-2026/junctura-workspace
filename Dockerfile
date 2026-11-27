# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0

# The portal builds from this repository alone: the shared UI library in
# packages/ui and the app in app/. The pack it presents is fetched at runtime
# from the backend's public /api/pack route, so one image can serve any pack
# the backend is configured with (JUNCTURA_PACK_DIR).
FROM node:24-alpine AS build
WORKDIR /workspace
COPY packages/ui/package.json packages/ui/package-lock.json packages/ui/
RUN npm --prefix packages/ui ci --ignore-scripts
COPY app/package.json app/package-lock.json app/
RUN npm --prefix app ci --ignore-scripts

COPY packages/ui/ packages/ui/
COPY app/ app/
RUN npm --prefix app run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/app/dist /srv/portal
