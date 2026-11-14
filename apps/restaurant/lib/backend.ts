import { createClient, SupabaseClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const cenaApiUrl = process.env.EXPO_PUBLIC_CENA_API_URL?.replace(/\/$/, '');
export const supabase: SupabaseClient | null = url && key ? createClient(url,key,{auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}}) : null;
export const hasBackend = !!supabase;

export type Restaurant = { id:string; name:string; address:string; curbside_enabled:boolean; role:string };
export async function signIn(email:string,password:string) {
  if (!supabase) return { error: null };
  const {error}=await supabase.auth.signInWithPassword({email,password}); return {error};
}
export async function signOut() { if (supabase) await supabase.auth.signOut(); }
export async function fetchRestaurants():Promise<Restaurant[]> {
  if (!supabase) return [];
  const {data,error}=await supabase.from('merchant_memberships').select('role,restaurant:restaurants(id,name,address,curbside_enabled)');
  if(error) throw error;
  return (data||[]).map((x:any)=>x.restaurant?{...x.restaurant,role:x.role}:null).filter(Boolean);
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
export type RestaurantPromotion={id:string;restaurant_id:string;code:string;discount_percent:number;starts_at:string;ends_at:string|null;max_redemptions:number|null;reserved_redemptions:number;redeemed_count:number;redemption_count:number;active:boolean;created_at:string;updated_at:string};
export async function fetchRestaurantPromotions(restaurantId:string):Promise<RestaurantPromotion[]>{
  if(!supabase)return[];
  const {data,error}=await supabase.rpc('list_restaurant_promotions',{p_restaurant_id:restaurantId});if(error)throw error;
  return (data||[]) as RestaurantPromotion[];
}
export async function saveRestaurantPromotion(restaurantId:string,promotion:{code:string;discountPercent:number;startsAt:string;endsAt:string|null;maxRedemptions:number|null;active:boolean}):Promise<RestaurantPromotion>{
  if(!supabase)throw new Error('Sign in to manage restaurant promotions.');
  const {data,error}=await supabase.rpc('save_restaurant_promotion',{p_restaurant_id:restaurantId,p_code:promotion.code,p_discount_percent:promotion.discountPercent,p_starts_at:promotion.startsAt,p_ends_at:promotion.endsAt,p_max_redemptions:promotion.maxRedemptions,p_active:promotion.active});if(error)throw error;
  return data as RestaurantPromotion;
}
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
  const select='id,status,pickup_mode,subtotal_cents,total_cents,discount_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,payment_method,payment_status,application_fee_cents,items:order_items(name_snapshot,quantity,options_snapshot),user_id';
  const {data,error}=await supabase.from('orders').select(select).eq('restaurant_id',restaurantId).or(`status.in.(placed,accepted,preparing,ready),pickup_starts_at.gte.${from}`).order('pickup_starts_at',{ascending:true});
  if(error && /options_snapshot|column .* does not exist/i.test(error.message)) {
    const legacy=await supabase.from('orders').select('id,status,pickup_mode,subtotal_cents,total_cents,discount_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,payment_method,payment_status,application_fee_cents,items:order_items(name_snapshot,quantity),user_id').eq('restaurant_id',restaurantId).or(`status.in.(placed,accepted,preparing,ready),pickup_starts_at.gte.${from}`).order('pickup_starts_at',{ascending:true});
    if(legacy.error)throw legacy.error;
    return legacy.data;
  }
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
export async function saveCatalogOptionGroups(itemId:string,restaurantId:string,groups:unknown[]) {
  if(!supabase) return;
  const {error}=await supabase.rpc('save_catalog_option_groups',{
    p_catalog_item_id:itemId,
    p_restaurant_id:restaurantId,
    p_option_groups:groups,
  });
  if(error?.code==='PGRST202') {
    const legacy=await supabase.from('catalog_items').update({option_groups:groups}).eq('id',itemId).eq('restaurant_id',restaurantId).select('id').maybeSingle();
    if(legacy.error)throw legacy.error;
    if(!legacy.data)throw new Error('This restaurant account cannot edit options for this item.');
    return;
  }
  if(error) throw error;
}
export async function saveCatalogItem(id:string,restaurantId:string,values:Record<string,unknown>,sourceSteps:string[]) {
  if(!supabase) return;
  const {data,error}=await supabase.rpc('save_catalog_item_draft',{
    p_catalog_item_id:id,
    p_restaurant_id:restaurantId,
    p_name:String(values.name||''),
    p_description:values.description==null?null:String(values.description),
    p_price_cents:Number(values.price_cents||0),
    p_regular_price_cents:values.regular_price_cents==null?null:Number(values.regular_price_cents),
    p_prepared_meal_total_cents:values.prepared_meal_total_cents==null?null:Number(values.prepared_meal_total_cents),
    p_equipment:Array.isArray(values.equipment)?values.equipment:[],
    p_allergens:Array.isArray(values.allergens)?values.allergens:[],
    p_active:values.active===undefined?true:Boolean(values.active),
    p_source_steps:sourceSteps,
  });
  if(error)throw error;
  const saved=data?.[0];
  if(!saved)throw new Error('The catalog draft was not saved.');
  return {id:saved.prep_draft_id,updated_at:saved.draft_updated_at};
}
export async function createCatalogItem(restaurantId:string,values:Record<string,unknown>,sourceSteps:string[]) {
  if(!supabase)return;
  const {data,error}=await supabase.rpc('create_catalog_item_draft',{
    p_restaurant_id:restaurantId,
    p_name:String(values.name||'New menu item'),
    p_description:String(values.description||''),
    p_price_cents:Number(values.price_cents||0),
    p_regular_price_cents:values.regular_price_cents==null?null:Number(values.regular_price_cents),
    p_prepared_meal_total_cents:values.prepared_meal_total_cents==null?null:Number(values.prepared_meal_total_cents),
    p_equipment:Array.isArray(values.equipment)?values.equipment:[],
    p_allergens:Array.isArray(values.allergens)?values.allergens:[],
    p_active:values.active===undefined?true:Boolean(values.active),
    p_source_steps:sourceSteps,
  });
  if(error)throw error;
  const saved=Array.isArray(data)?data[0]:data;
  if(!saved?.catalog_item_id)throw new Error('The catalog item was not created.');
  return {id:saved.catalog_item_id,draftId:saved.prep_draft_id,updatedAt:saved.draft_updated_at};
}
export async function saveCatalogPrepMinutes(itemId:string,restaurantId:string,prepMinutes:number) {
  if(!supabase) return;
  if(!Number.isInteger(prepMinutes)||prepMinutes<0||prepMinutes>240)throw new Error('Estimated prep time must be a whole number from 0 to 240.');
  const {data,error}=await supabase.from('catalog_items').update({prep_minutes:prepMinutes}).eq('id',itemId).eq('restaurant_id',restaurantId).select('id').maybeSingle();
  if(error)throw error;
  if(!data)throw new Error('This restaurant account cannot update the prep time for this item.');
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
  const {error}=await supabase.rpc('create_pickup_slot_with_inventory',{
    p_restaurant_id:restaurantId,
    p_item_ids:items,
    p_starts_at:startsAt.toISOString(),
    p_window_minutes:windowMinutes,
    p_cutoff_minutes:cutoffMinutes,
    p_capacity:capacity,
  });
  if(error)throw error;
}
export async function fetchSlots(restaurantId:string) {
  if(!supabase) return null;
  const {data,error}=await supabase.from('pickup_slots').select('*,inventory:slot_item_inventory(item_id,available_qty,reserved_qty)').eq('restaurant_id',restaurantId).eq('active',true).gte('starts_at',new Date().toISOString()).order('starts_at');
  if(error) throw error; return data;
}
