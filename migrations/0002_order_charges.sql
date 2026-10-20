-- Charges an online order can have beyond items and tax, for itemized splits.
-- All integer cents; existing splits read as having none.
ALTER TABLE "Expense" ADD COLUMN "tipFeesCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Expense" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Expense" ADD COLUMN "refundCents" INTEGER NOT NULL DEFAULT 0;

-- The Walmart or Sam's Club order a split was imported from ("walmart-<id>"),
-- so the same order can't be split twice.
ALTER TABLE "Expense" ADD COLUMN "orderRef" TEXT;
CREATE UNIQUE INDEX "Expense_orderRef_key" ON "Expense"("orderRef");

-- A returned item stays on the receipt at full price; its money back is the refund.
ALTER TABLE "Item" ADD COLUMN "returned" BOOLEAN NOT NULL DEFAULT false;
