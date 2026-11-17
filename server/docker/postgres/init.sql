-- Runs once, on the first start of an empty volume. The server creates its own tables on start.
CREATE DATABASE heyokay_test;
\connect heyokay_test
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
\connect heyokay
CREATE EXTENSION IF NOT EXISTS vector;
