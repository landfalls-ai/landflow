-- Runs once, when the postgres-data volume is first initialised (as POSTGRES_USER, in POSTGRES_DB).
-- landflow       the application database
-- landflow_test  scratch database for the databases plugin's integration tests

CREATE EXTENSION IF NOT EXISTS vector;

CREATE DATABASE landflow_test;
\connect landflow_test
CREATE EXTENSION IF NOT EXISTS vector;
