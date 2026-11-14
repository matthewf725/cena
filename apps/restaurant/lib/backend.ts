import { createClient, SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const cenaApiUrl = process.env.EXPO_PUBLIC_CENA_API_URL?.replace(/\/$/, '');
export const supabase: SupabaseClient | null = url && key ? createClient(url,key,{auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}}) : null;
export const hasBackend = !!supabase;

export type Restaurant = { id:string; name:string; address:string; curbside_enabled:boolean };
export async function signIn(email:string,password:string) {
  if (!supabase) return { error: null };
  const {error}=await supabase.auth.signInWithPassword({email,password}); return {error};
}
export async function signOut() { if (supabase) await supabase.auth.signOut(); }
export async function fetchRestaurants():Promise<Restaurant[]> {
  if (!supabase) return [];
  const {data,error}=await supabase.from('merchant_memberships').select('restaurant:restaurants(id,name,address,curbside_enabled)');
  if(error) throw error;
  return (data||[]).map((x:any)=>x.restaurant).filter(Boolean);
}
export async function updateCurbside(restaurantId:string,enabled:boolean) {
  if(!supabase)return enabled;
  const {data,error}=await supabase.from('restaurants').update({curbside_enabled:enabled}).eq('id',restaurantId).select('curbside_enabled').single();if(error)throw error;return data.curbside_enabled as boolean;
}
export type RestaurantPaymentStatus={status:'not_connected'|'pending'|'ready';application_fee_cents:number};
async function cenaApiRequest<T>(path:string,method:'GET'|'POST'='GET'):Promise<T>{
  if(!cenaApiUrl||!supabase)throw new Error('Cena payments API is not configured.');
  const {data,error}=await supabase.auth.getSession();if(error)throw error;
  const token=data.session?.access_token;if(!token)throw new Error('Sign in again to manage payouts.');
  const response=await fetch(`${cenaApiUrl}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(body?.error||body?.message||`Payment request failed (${response.status}).`);
  return body as T;
}
export async function fetchRestaurantPaymentStatus(restaurantId:string):Promise<RestaurantPaymentStatus|null>{
  if(!cenaApiUrl)return null;
  return cenaApiRequest<RestaurantPaymentStatus>(`/v1/restaurants/${encodeURIComponent(restaurantId)}/payments`);
}
export async function createStripeOnboardingLink(restaurantId:string):Promise<string>{
  const result=await cenaApiRequest<{url:string}>(`/v1/restaurants/${encodeURIComponent(restaurantId)}/stripe-onboarding`,'POST');
  if(!result?.url)throw new Error('Stripe setup link was not returned.');
  return result.url;
}
export type OrderRefundResult={status:'refunded'|'pending'|'failed'};
export async function refundOrder(id:string):Promise<OrderRefundResult>{
  if(!cenaApiUrl||!supabase)throw new Error('Cena refund API is not configured.');
  const {data,error}=await supabase.auth.getSession();if(error)throw error;
  const token=data.session?.access_token;if(!token)throw new Error('Sign in again to refund this order.');
  const response=await fetch(`${cenaApiUrl}/v1/orders/${encodeURIComponent(id)}/refund`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(body?.error||body?.message||`Refund request failed (${response.status}).`);
  if(!body||!['refunded','pending','failed'].includes(body.status))throw new Error('The refund service returned an unrecognized status.');
  return body as OrderRefundResult;
}
export async function fetchOrders(restaurantId:string) {
  if(!supabase) return null;
  const from=new Date(Date.now()-30*24*60*60_000).toISOString();
  const {data,error}=await supabase.from('orders').select('id,status,pickup_mode,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,payment_method,payment_status,application_fee_cents,items:order_items(name_snapshot,quantity),user_id').eq('restaurant_id',restaurantId).or(`status.in.(placed,accepted,preparing,ready),pickup_starts_at.gte.${from}`).order('pickup_starts_at',{ascending:true});
  if(error) throw error; return data;
}
export async function setOrderStatus(id:string,status:string) {
  if(!supabase) return;
  if(cenaApiUrl){
    const {data,error:sessionError}=await supabase.auth.getSession();
    if(sessionError)throw sessionError;
    const token=data.session?.access_token;
    if(!token)throw new Error('Sign in again to update this order.');
    const response=await fetch(`${cenaApiUrl}/v1/orders/${encodeURIComponent(id)}/status`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      body:JSON.stringify({status}),
    });
    if(!response.ok){
      const payload=await response.json().catch(()=>null);
      throw new Error(payload?.error||payload?.message||`Order update failed (${response.status}).`);
    }
    return;
  }
  const {error}=await supabase.rpc('update_order_status',{p_order_id:id,p_status:status}); if(error) throw error;
}
export async function fetchCatalog(restaurantId:string) {
  if(!supabase) return null;
  const {data,error}=await supabase.from('catalog_items').select('*').eq('restaurant_id',restaurantId).order('category').order('name');
  if(error) throw error;
  const {data:drafts,error:draftError}=await supabase.from('prep_drafts').select('id,catalog_item_id,source_steps,generated_steps,updated_at').eq('restaurant_id',restaurantId);
  if(draftError) throw draftError;
  return (data||[]).map(item=>{const d=(drafts||[]).find((x:any)=>x.catalog_item_id===item.id);return{...item,source_steps:d?.source_steps||[],generated_steps:d?.generated_steps||[],draft_id:d?.id||null,draft_updated_at:d?.updated_at||null}});
}
export async function saveCatalogItem(id:string,restaurantId:string,values:Record<string,unknown>,sourceSteps:string[]) {
  if(!supabase) return;
  const {error}=await supabase.from('catalog_items').update(values).eq('id',id); if(error) throw error;
  const {data,error:readError}=await supabase.from('prep_drafts').select('id').eq('catalog_item_id',id).maybeSingle();if(readError)throw readError;
  const draft={restaurant_id:restaurantId,catalog_item_id:id,name:String(values.name||''),description:'',price_cents:Number(values.price_cents||0),source_steps:sourceSteps};
  const result=data?await supabase.from('prep_drafts').update({name:draft.name,price_cents:draft.price_cents,source_steps:draft.source_steps,generated_steps:[],active:values.active===undefined?true:values.active}).eq('id',data.id).select('id,updated_at').single():await supabase.from('prep_drafts').insert({...draft,generated_steps:[],active:values.active===undefined?true:values.active}).select('id,updated_at').single();
  if(result.error)throw result.error;
  return result.data;
}
export async function createCatalogItem(restaurantId:string,values:Record<string,unknown>,sourceSteps:string[]) {
  if(!supabase)return;
  const {data,error}=await supabase.from('catalog_items').insert({...values,restaurant_id:restaurantId,active:false}).select('id').single();if(error)throw error;
  const {error:draftError}=await supabase.from('prep_drafts').insert({restaurant_id:restaurantId,catalog_item_id:data.id,name:String(values.name||'New menu item'),description:String(values.description||''),price_cents:Number(values.price_cents||0),source_steps:sourceSteps,active:values.active===undefined?true:values.active});if(draftError)throw draftError;
}
export async function generatePrep(itemId:string) {
  if(!supabase)throw new Error('Configure Supabase before generating chef steps.');
  const {data,error}=await supabase.functions.invoke('generate-prep',{body:{item_id:itemId}});if(error)throw error;return data as {generated_steps:string[];updated_at:string};
}
export async function publishCatalogItem(draftId:string,expectedUpdatedAt:string,reviewedSteps:string[]) {
  if(!supabase)return;
  if(!draftId||!expectedUpdatedAt)throw new Error('Generate or save a chef draft before publishing.');
  const {error:publishError}=await supabase.rpc('publish_prep_draft',{p_draft_id:draftId,p_expected_updated_at:expectedUpdatedAt,p_reviewed_steps:reviewedSteps});if(publishError)throw publishError;
}
export async function saveSlotInventory(slotId:string,itemId:string,availableQty:number) {
  if(!supabase)return;
  const {data,error}=await supabase.from('slot_item_inventory').select('reserved_qty').eq('slot_id',slotId).eq('item_id',itemId).maybeSingle();if(error)throw error;
  const qty=Math.max(availableQty,data?.reserved_qty||0);
  const result=data?await supabase.from('slot_item_inventory').update({available_qty:qty}).eq('slot_id',slotId).eq('item_id',itemId):await supabase.from('slot_item_inventory').insert({slot_id:slotId,item_id:itemId,available_qty:qty});if(result.error)throw result.error;
}
export async function createPickupSlot(restaurantId:string,items:string[],startsAt:Date,windowMinutes:number,cutoffMinutes:number,capacity:number) {
  if(!supabase)return;
  const start=startsAt;
  const end=new Date(start.getTime()+windowMinutes*60_000),cutoff=new Date(start.getTime()-cutoffMinutes*60_000);
  const {data,error}=await supabase.from('pickup_slots').insert({restaurant_id:restaurantId,starts_at:start.toISOString(),ends_at:end.toISOString(),cutoff_at:cutoff.toISOString(),capacity}).select('id').single();if(error)throw error;
  if(items.length){const {error:stockError}=await supabase.from('slot_item_inventory').insert(items.map(item_id=>({slot_id:data.id,item_id,available_qty:8})));if(stockError)throw stockError;}
}
export async function fetchSlots(restaurantId:string) {
  if(!supabase) return null;
  const {data,error}=await supabase.from('pickup_slots').select('*,inventory:slot_item_inventory(item_id,available_qty,reserved_qty)').eq('restaurant_id',restaurantId).eq('active',true).gte('starts_at',new Date().toISOString()).order('starts_at');
  if(error) throw error; return data;
}
