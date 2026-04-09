#!/bin/bash
# Postgres init script — creates the `inventory` database alongside
# the default `billing` (which Postgres' POSTGRES_DB env var creates
# automatically). Mounted into /docker-entrypoint-initdb.d/ in the
# compose file; runs once on first container start.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE DATABASE inventory;
EOSQL
