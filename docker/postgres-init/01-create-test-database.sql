-- The integration suite runs against its own database on the same server so that
-- a schema reset between tests never touches development data.
CREATE DATABASE billing_test OWNER billing;
