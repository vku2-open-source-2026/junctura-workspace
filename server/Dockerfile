# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0

FROM node:24-alpine
WORKDIR /workspace
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev --ignore-scripts
COPY .junctura-health/seed/data/accounts.json .junctura-health/seed/data/
COPY server/ server/
USER node
CMD ["node", "server/main.mjs"]
