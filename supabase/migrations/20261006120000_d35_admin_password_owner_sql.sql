-- Bedo Chat - D-35: admin password set by the owner from the SQL editor (docs/owner-sql/set-super-admin.sql).
--
-- The database cannot produce the API's Argon2id hash, so the owner script stores a temporary bcrypt hash
-- (pgcrypto crypt(), cost 12) of the password's SHA-256 (base64). The API accepts it once and, on the first
-- successful sign-in, replaces it with its own Argon2id hash after checking the full password rules (D-34).
-- Only that exact bcrypt form is allowed besides Argon2id; nothing else about admin accounts changes.

alter table app.admin_accounts drop constraint admin_accounts_password_hash_check;
alter table app.admin_accounts add constraint admin_accounts_password_hash_check check (
  password_hash is null
  or (password_hash like '$argon2id$%' and length(password_hash) <= 512)
  or password_hash ~ '^\$2a\$12\$[./A-Za-z0-9]{53}$'
);

comment on column app.admin_accounts.password_hash is
  'Argon2id hash (PHC string) of the admin password (D-34), or until the first sign-in a bcrypt hash written by the owner SQL script (D-35). NULL until a password is set.';
