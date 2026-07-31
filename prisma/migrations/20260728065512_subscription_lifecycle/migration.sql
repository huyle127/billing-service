-- CreateTable
CREATE TABLE "subscription_checkouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "pricing_option_id" UUID NOT NULL,
    "provider_checkout_session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_checkouts_provider_checkout_session_id_key" ON "subscription_checkouts"("provider_checkout_session_id");

-- CreateIndex
CREATE INDEX "subscription_checkouts_user_id_product_id_idx" ON "subscription_checkouts"("user_id", "product_id");

-- AddForeignKey
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_pricing_option_id_fkey" FOREIGN KEY ("pricing_option_id") REFERENCES "pricing_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express (design D6).
-- ---------------------------------------------------------------------------

-- A subscription the provider has ended is never returned to the live set.
--
-- The one-live-row index already stops a *second* live row appearing, but not a
-- terminal row being flipped back to a live status — which is what "never revive
-- a terminal Subscription row" forbids, and what a Pro → Free transition would
-- undo if some later code path tried to "restore" the paid row instead of
-- creating a new one.
--
-- Scoped to the statuses Stripe itself never leaves: `canceled` and
-- `incomplete_expired` are final at the provider, so rejecting a move out of
-- them can never contradict a real provider report. `unpaid` and `paused` are
-- deliberately excluded even though this service classifies them as terminal —
-- Stripe can move a subscription out of either, and local status is a projection
-- of Stripe's, so a trigger must not refuse a status the provider is reporting.
CREATE OR REPLACE FUNCTION "reject_terminal_subscription_revival"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" IN ('CANCELED', 'INCOMPLETE_EXPIRED')
     AND NEW."status" IN ('ACTIVE', 'TRIALING', 'PAST_DUE') THEN
    RAISE EXCEPTION
      'subscription % is terminal at the provider (%) and cannot return to the live set as %',
      OLD."id", OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subscriptions_no_revival_from_terminal"
  BEFORE UPDATE ON "subscriptions"
  FOR EACH ROW
  EXECUTE FUNCTION "reject_terminal_subscription_revival"();
