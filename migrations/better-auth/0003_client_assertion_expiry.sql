-- Chickpea deletes expired client assertion records after token requests that carry one.
CREATE INDEX "oauthClientAssertion_expiresAt_idx" ON "oauthClientAssertion" ("expiresAt");
