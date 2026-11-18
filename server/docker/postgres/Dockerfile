# Local Postgres for Hey-Okay: PostgreSQL 16 with PostGIS (matching) and pgvector (dedup embeddings).
# Built on the official bookworm image: the postgis/postgis 16 images are on Debian bullseye, whose
# apt.postgresql.org repository has been archived, so pgvector can no longer be installed into them.
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-postgis-3 postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql /docker-entrypoint-initdb.d/20-heyokay.sql
