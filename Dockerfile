# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0

FROM node:24-alpine AS build
WORKDIR /workspace
COPY .junctura-health/ui/package.json .junctura-health/ui/package-lock.json .junctura-health/ui/
RUN npm --prefix .junctura-health/ui ci --ignore-scripts
COPY app/package.json app/package-lock.json app/
RUN npm --prefix app ci --ignore-scripts

COPY .junctura-health/ui/src/ .junctura-health/ui/src/
COPY .junctura-health/contracts/ .junctura-health/contracts/
COPY .junctura-health/demo/plan.mjs .junctura-health/demo/
COPY .junctura-health/workflows/ .junctura-health/workflows/
COPY .junctura-health/seed/data/accounts.json .junctura-health/seed/data/
COPY app/ app/
RUN npm --prefix app run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/app/dist /srv/portal
