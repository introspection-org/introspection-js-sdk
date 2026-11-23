#!/bin/sh
set -u
mkdir -p /logs/verifier
node /tests/check.mjs
