create table public.restaurant_payment_accounts (
  restaurant_id uuid primary key references public.restaurants(id) on delete restrict,
  stripe_account_id text not null unique check (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  application_fee_cents integer not null default 175 check (application_fee_cents between 150 and 200),
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.restaurant_payment_accounts enable row level security;
revoke all on public.restaurant_payment_accounts from public, anon, authenticated;
grant select, insert, update on public.restaurant_payment_accounts to service_role;

notify pgrst, 'reload schema';
