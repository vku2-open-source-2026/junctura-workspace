# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0

FROM node:24-alpine
WORKDIR /workspace
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev --ignore-scripts
COPY server/ server/
# The pack reader loads the published schemas, and the backend serves the
# projection of the configured sample pack (JUNCTURA_PACK_DIR picks another
# one, e.g. examples/packs/education).
COPY schemas/ schemas/
COPY examples/packs/ examples/packs/
USER node
CMD ["node", "server/main.mjs"]
