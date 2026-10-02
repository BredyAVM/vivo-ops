export type AccountRuleRole = 'admin'|'master'|'advisor'|'kitchen'|'counter'|'driver';
export type AccountRuleMethod = 'payment_mobile'|'transfer'|'zelle'|'wallet_usd'|'cash_usd'|'cash_ves'|'pos'|'retention';
export const ACCOUNT_RULE_ROLES: AccountRuleRole[] = ['admin','master','advisor','kitchen','counter','driver'];
export const ACCOUNT_RULE_METHODS: AccountRuleMethod[] = ['payment_mobile','transfer','zelle','wallet_usd','cash_usd','cash_ves','pos','retention'];
type Account = { name: string; currencyCode: string; accountKind: string };
export function isPaymentMethodApplicableToAccount(method: AccountRuleMethod, account: Account) {
  const name=account.name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(name.includes('retencion'))return method==='retention';
  if(method==='payment_mobile')return account.currencyCode==='VES'&&['bank','wallet'].includes(account.accountKind);
  if(method==='transfer')return account.accountKind==='bank';
  if(method==='zelle')return account.currencyCode==='USD'&&account.accountKind==='bank';
  if(method==='wallet_usd')return account.currencyCode==='USD'&&account.accountKind==='wallet';
  if(method==='cash_usd')return account.currencyCode==='USD'&&account.accountKind==='cash';
  if(method==='cash_ves')return account.currencyCode==='VES'&&account.accountKind==='cash';
  if(method==='pos')return account.accountKind==='pos';
  if(method==='retention')return account.accountKind==='fund';
  return false;
}
export function getPaymentMethodRolesForAccount(method: AccountRuleMethod, account: Account): AccountRuleRole[] {
  if(!isPaymentMethodApplicableToAccount(method,account))return [];
  if(['payment_mobile','transfer','zelle','wallet_usd'].includes(method))return ['admin','master','advisor','counter'];
  if(method==='retention')return ['admin','master'];
  if(method==='pos')return ['admin','master','counter'];
  if(method==='cash_usd'||method==='cash_ves')return ['admin','master','counter','driver'];
  return ['admin','master'];
}
