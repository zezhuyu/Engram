# Multi-container remote-capture verification image (one image, three roles: server, client B, client C).
# Build context is a staged directory (see scripts/xhost/run.mjs): dist, bin, package.json, node_modules, scripts/xhost.
FROM node:22-bookworm
WORKDIR /opt/engram
COPY . /opt/engram
RUN mkdir -p /work /data /etc/xhost
CMD ["sleep", "infinity"]
