
Failed

Mar 26, 2026, 4:00 AM GMT+5
Get Help
Details
Build Logs
Deploy Logs
Network Flow Logs
Search build logs

You reached the start of the range
Mar 26, 2026, 3:55 AM
 
[Region: us-west1]
Using Detected Dockerfile
=========================
context: 9z14-v65v

internal
load build definition from Dockerfile
0ms

internal
load .dockerignore
9ms

1
FROM docker.io/library/node:18-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e
10ms

internal
load build context
25ms

2
RUN apt-get update && apt-get install -y     python3     python3-pip     python3-venv     build-essential     && rm -rf /var/lib/apt/lists/*
23s
done.

3
WORKDIR /app
66ms

5
WORKDIR /app/wa
12ms

6
RUN npm install --omit=dev --legacy-peer-deps
3s
npm error A complete log of this run can be found in: /root/.npm/_logs/2026-03-25T23_00_45_429Z-debug-0.log
17 |     # Install Node.js dependencies (Force clean install)
18 |     WORKDIR /app/wa
19 | >>> RUN npm install --omit=dev --legacy-peer-deps
20 |
21 |     # Setup Python Environment
-------------------
ERROR: failed to build: failed to solve: process "/bin/sh -c npm install --omit=dev --legacy-peer-deps" did not complete successfully: exit code: 254
