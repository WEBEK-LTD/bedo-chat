-- Bedo Chat - D-24: a number leaves the academy phone list when its account is deleted (on admin
-- approval) or when the account changes to a new number. The removed entry (number, note, who added it
-- and when) is written to app.audit_log in the same transaction; identity history keeps the number.
grant delete on app.academy_phone_list to bedo_runtime;

comment on table app.academy_phone_list is
  'Phone numbers (E.164) allowed to sign in. Added or imported by system admins; removed only by D-24 (account deletion approved, or phone number changed), each removal recorded in app.audit_log.';
