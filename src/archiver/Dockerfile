# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# Install production dependencies in a separate stage so the npm cache and
# lockfile tooling never end up in the runtime image.
FROM public.ecr.aws/lambda/nodejs:${NODE_VERSION} AS deps
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM public.ecr.aws/lambda/nodejs:${NODE_VERSION}
COPY --from=deps /build/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY package.json app.mjs ${LAMBDA_TASK_ROOT}/
COPY lib/ ${LAMBDA_TASK_ROOT}/lib/

CMD ["app.handler"]
