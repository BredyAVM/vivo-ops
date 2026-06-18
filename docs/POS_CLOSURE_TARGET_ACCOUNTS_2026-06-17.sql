-- Asociacion de puntos con cuenta destino para consolidacion de cierres.
-- Ajusta los IDs si algun punto debe consolidar en otra cuenta.

update public.money_account_closure_profiles as profile
set default_target_money_account_id = mapping.target_money_account_id
from (
  values
    (4, 5),  -- Punto BNC -> BNC Juridico
    (10, 1), -- Punto BDV 1 -> BDV Juridico
    (11, 1)  -- Punto BDV 2 -> BDV Juridico
) as mapping(money_account_id, target_money_account_id)
where profile.money_account_id = mapping.money_account_id
  and profile.closure_kind = 'pos';

select
  source.id as point_id,
  source.name as point_name,
  target.id as target_account_id,
  target.name as target_account_name,
  profile.generates_transfer_on_close
from public.money_account_closure_profiles profile
join public.money_accounts source on source.id = profile.money_account_id
left join public.money_accounts target on target.id = profile.default_target_money_account_id
where profile.closure_kind = 'pos'
order by source.id;
