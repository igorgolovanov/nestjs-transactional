import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  sku: text('sku').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: text('status').notNull().$type<'placed' | 'shipped'>(),
});

export const schema = { orders };
