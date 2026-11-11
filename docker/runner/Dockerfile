# The designc selfcheck image: Node 22 (pinned by digest) plus python3 + PyYAML for the Python gate.
# Nothing is installed from the project here; `npm ci --ignore-scripts` runs at selfcheck time.
FROM node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-yaml git \
    && rm -rf /var/lib/apt/lists/*
