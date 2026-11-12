export function normalizeAccountType(value){
 const v=String(value||'').trim().toLowerCase();
 if(['individual','personal','private'].includes(v))return 'individual';
 if(['business','fleet','business/fleet','commercial'].includes(v))return 'business';
 return null;
}
export function accountTypeFor(input){
 // Compatibility for older administrative/read callers. New voice payloads always
 // include this field; an explicit missing/unknown answer must never default.
 return Object.hasOwn(input,'customer_account_type')?normalizeAccountType(input.customer_account_type):'individual';
}
export async function selectAccountType(page,type){
 const canonical=normalizeAccountType(type);
 if(!canonical)throw new Error('account_type_required');
 const chosen=page.getByRole('radio',{name:canonical==='business'?'Business':'Individual',exact:true});
 await chosen.waitFor({state:'attached',timeout:12000});
 if(!await chosen.isChecked())await chosen.locator('xpath=ancestor::label[1]').click();
 if(!await chosen.isChecked())throw new Error('account_selection_failed');
 return canonical;
}
export function nextAccountStep(input){
 if(accountTypeFor(input)==='business'&&!String(input.business_name||'').trim())return 'business_name';
 if(!String(input.customer_name||'').trim())return 'contact_name';
 if(!['vehicle_make','vehicle_year','vehicle_model','vehicle_type'].every(k=>input[k]))return 'vehicle_year';
 return 'prepare_hook';
}
