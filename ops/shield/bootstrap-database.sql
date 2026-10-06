-- Run once as cluster administrator after approval. Supply shield_password with
-- a private psql variables file, never argv or a committed file. Existing names
-- cause failure rather than repurposing an existing database or role.
\set ON_ERROR_STOP on
SET password_encryption = 'scram-sha-256';
CREATE ROLE shield_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD :'shield_password';
CREATE DATABASE shield_prod OWNER shield_app;
REVOKE ALL ON DATABASE shield_prod FROM PUBLIC;
GRANT CONNECT ON DATABASE shield_prod TO shield_app;
\connect shield_prod
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO shield_app;
ALTER ROLE shield_app IN DATABASE shield_prod SET statement_timeout='15s';
ALTER ROLE shield_app IN DATABASE shield_prod SET idle_in_transaction_session_timeout='15s';
