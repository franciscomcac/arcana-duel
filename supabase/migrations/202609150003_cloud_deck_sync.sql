alter table public.stored_decks
  add column if not exists client_key text,
  add column if not exists client_updated_at timestamptz;

update public.stored_decks
set client_key = coalesce(client_key, id::text),
    client_updated_at = coalesce(client_updated_at, updated_at, now())
where client_key is null or client_updated_at is null;

alter table public.stored_decks
  alter column client_key set not null,
  alter column client_updated_at set not null,
  alter column client_updated_at set default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stored_decks_client_key_length'
      and conrelid = 'public.stored_decks'::regclass
  ) then
    alter table public.stored_decks
      add constraint stored_decks_client_key_length
      check (char_length(client_key) between 1 and 160);
  end if;
end;
$$;

create unique index if not exists stored_decks_owner_client_key_idx
  on public.stored_decks(owner_id, client_key);
