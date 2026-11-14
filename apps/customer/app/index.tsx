import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Animated, AppState, Image, ImageBackground, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text as LogoText, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Location from 'expo-location';
import { ChevronRight, House, ShoppingBag, MapPin, Star, Plus, Minus, ArrowLeft, CircleCheck, CalendarDays, Phone, Mail, Check, CarFront, PackageCheck, ChefHat, Soup, Bell, CreditCard, UserRound } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Enter, useReducedMotion } from '../components/motion';
import { DiscoveryFeed } from '../components/discovery-feed';
import { HomeHeader, HomeSearch, HomeWelcome, homeContentMaxWidth, searchGap, welcomeFadeEnd, welcomeHeight } from '../components/home-chrome';
import { Text, TextInput } from '../components/type';
import { Account } from '../components/account';
import { Bag, type BagLine } from '../components/bag';
import { LocationPicker } from '../components/location-picker';
import { MealPrice } from '../components/meal-price';
import { PickupCountdown } from '../components/pickup-countdown';
import { Kitchen, Meal, kitchens as demoKitchens } from '../lib/data';
import { formatDistance, sanFrancisco, type PickupOrigin } from '../lib/discovery';
import { foodPhoto } from '../lib/food-photos';
import { dateLabel, dayOffset } from '../lib/pickup-days';
import { cancelCheckout, CheckoutRequestError, createCheckout, fetchCheckoutStatus, fetchKitchenBySlug, fetchOrderHistory, fetchRestaurantRecentOrders, isTrustedCheckoutURL, loadKitchenMenu, quoteCheckout, sendEmailCode, supabase, trackEvent, verifyEmailCode, type CheckoutQuote } from '../lib/supabase';
import { loadCustomerLocalState, saveCustomerLocalState, type CustomerLocalSnapshot } from '../lib/local-state';
import { loadCustomerDisplayName } from '../lib/profile';

const footerTabs = [{ name: 'Home', Icon: House }, { name: 'Orders', Icon: PackageCheck }, { name: 'Bag', Icon: ShoppingBag }] as const;
type Tab = typeof footerTabs[number]['name'] | 'Account';
const maroon='#5D100A', ivory='#FAF6F3', ink='#271D19', muted='#77645B', line='#E8DCD5', green='#245C40';
const checkoutLeadMs=33*60*1000;
const quoteKey=(restaurantId:string,slotId:string,items:{item_id:string;quantity:number}[],promoCode:string)=>JSON.stringify({restaurantId,slotId,items:[...items].sort((a,b)=>a.item_id.localeCompare(b.item_id)),promoCode:promoCode.trim().toUpperCase()||null});
const checkoutRejectionMessages={
  promo_unavailable:'That discount code is unavailable. Check the code or continue without it.',
  pickup_unavailable:'That pickup time is no longer available. Choose another time.',
  item_unavailable:'A meal kit in your bag is unavailable for that pickup time. Update your bag or choose another time.',
  curbside_unavailable:'Curbside is unavailable. Choose counter pickup to continue.',
  restaurant_unavailable:'This restaurant isn’t taking online orders right now.',
  order_total_too_low:'The order total is too low for online payment. Update your bag or remove the discount code.',
} as const;
type CheckoutRejection=keyof typeof checkoutRejectionMessages;
function knownCheckoutRejection(error:unknown):{reason:CheckoutRejection;message:string}|null{
  if(!(error instanceof CheckoutRequestError)||error.status!==422||typeof error.reason!=='string'||!Object.prototype.hasOwnProperty.call(checkoutRejectionMessages,error.reason))return null;
  const reason=error.reason as CheckoutRejection;
  return {reason,message:checkoutRejectionMessages[reason]};
}
const dollars=(n:number)=>`$${n.toFixed(2)}`;
const recentlyOrdered: Record<string,{qty:number; options:string}> = { lasagna:{qty:2,options:'Extra parmesan · No parsley'}, tacos:{qty:1,options:'Salsa on the side'} };

export default function Home() {
  const insets=useSafeAreaInsets();
  const {width,height}=useWindowDimensions();
  const reduceMotion=useReducedMotion();
  const contentRadius=16+Math.max(0,Math.min(10,(390-width)*.08));
  const safeWidth=width-insets.left-insets.right;
  const contentWidth=Math.min(safeWidth,homeContentMaxWidth);
  const contentSide=contentWidth<390?14:18;
  const shortScreen=height<490;
  const headerSide=Math.round(Math.max(12,Math.min(34,safeWidth*.044)));
  const identityHeight=shortScreen?48:safeWidth>=640?66:58;
  const searchHeight=shortScreen?44:safeWidth>=640?52:48;
  const navPadding=Math.max(shortScreen?4:9,insets.bottom);
  const navHeight=(shortScreen?48:safeWidth>=640?64:56)+navPadding;
  const homeScrollY=useRef(new Animated.Value(0)).current;
  const collapsedRef=useRef(false);
  const [welcomeCollapsed,setWelcomeCollapsed]=useState(false);
  const [tab,setTab]=useState<Tab>('Home'), [active,setActive]=useState<Kitchen|null>(null), [backendOrders,setBackendOrders]=useState<any[]>([]), [completedItems,setCompletedItems]=useState<{meal:Meal;qty:number}[]>([]), [query,setQuery]=useState(''), [cart,setCart]=useState<Record<string,{meal:Meal;qty:number;options:string;restaurantId:string}>>({}), [selected,setSelected]=useState<Meal|null>(null), [selectedQuantity,setSelectedQuantity]=useState(1), [selectedOptions,setSelectedOptions]=useState<string[]>([]), [flow,setFlow]=useState<'menu'|'date'|'time'|'contact'|'done'>('menu'), [date,setDate]=useState(1), [slot,setSlot]=useState('5:30 PM'), [curb,setCurb]=useState(false), [email,setEmail]=useState(''), [phone,setPhone]=useState(''), [displayName,setDisplayName]=useState(''), [vehicleMake,setVehicleMake]=useState(''), [vehicleModel,setVehicleModel]=useState(''), [vehicleColor,setVehicleColor]=useState(''), [equipment,setEquipment]=useState<string[]>([]), [analyticsConsented,setAnalyticsConsented]=useState(false), [termsAccepted,setTermsAccepted]=useState(false), [hydrated,setHydrated]=useState(false), [authResolved,setAuthResolved]=useState(!supabase), [otpSent,setOtpSent]=useState(false), [otpCode,setOtpCode]=useState(''), [now,setNow]=useState(Date.now()), [notice,setNotice]=useState<{title:string;message:string}|null>(null);
  const [checkingBag,setCheckingBag]=useState(false);
  const [otpResendAt,setOtpResendAt]=useState(0);
  const [otpBusy,setOtpBusy]=useState(false);
  const [otpFeedback,setOtpFeedback]=useState('');
  const checkoutEmailRef=useRef(email);
  checkoutEmailRef.current=email;
  const [cartRevision,setCartRevision]=useState('');
  const cartRevisionRef=useRef('');
  const cartRef=useRef(cart);
  cartRef.current=cart;
  const flowRef=useRef(flow);flowRef.current=flow;
  const [origin,setOrigin]=useState<PickupOrigin>(sanFrancisco);
  const [locationLabel,setLocationLabel]=useState('From San Francisco');
  const [showLocation,setShowLocation]=useState(false);
  const pickupAreaButtonRef=useRef<any>(null);
  const [locating,setLocating]=useState(false);
  const [menuLoading,setMenuLoading]=useState(false);
  const [demoRecentIds,setDemoRecentIds]=useState<string[]>([]);
  const [demoRecentMeals,setDemoRecentMeals]=useState<string[]>([]);
  const [authenticated,setAuthenticated]=useState(false);
  const [authUserId,setAuthUserId]=useState<string|null>(null);
  const [savedName,setSavedName]=useState<{userId:string;name:string}|null>(null);
  const [profileRevision,setProfileRevision]=useState(0);
  const currentAuthUserId=useRef<string|null>(null);
  const initialAuthEvent=useRef(true);
  const storageOwnerRef=useRef<string|null|undefined>(undefined);
  const storageLoadGeneration=useRef(0);
  const storageWriteQueue=useRef<Promise<void>>(Promise.resolve());
  const guestBagToAdopt=useRef<{snapshot:CustomerLocalSnapshot;checkoutInProgress:boolean}|null>(null);
  const [checkout,setCheckout]=useState<{orderId:string;url:string;restaurantId:string;date:number;slot:string;email:string;total?:number;ownerUserId:string;cartRevision?:string;items?:{meal:Meal;qty:number}[]}|null>(null);
  const [showCheckoutRecovery,setShowCheckoutRecovery]=useState(true);
  const [paymentStatus,setPaymentStatus]=useState<'pending'|'paid'|'expired'|'failed'|'cancelled'|'refunded'|null>(null);
  const [promoCode,setPromoCode]=useState('');
  const [quote,setQuote]=useState<{data:CheckoutQuote;fingerprint:string}|null>(null);
  const [quoteLoading,setQuoteLoading]=useState(false);
  const [quoteError,setQuoteError]=useState('');
  const [quoteRecovery,setQuoteRecovery]=useState<CheckoutRequestError['reason']|null>(null);
  const quoteFlight=useRef<string|null>(null);
  const [completedTotal,setCompletedTotal]=useState(0);
  const checkingPayment=useRef(false);
  const paidCheckout=useRef<string|null>(null);
  const emailEdited=useRef(false);
  const storageHydrated=useRef(false);
  const sessionEmail=useRef<string|null>(null);
  const demoRecentIdsRef=useRef(demoRecentIds);demoRecentIdsRef.current=demoRecentIds;
  const demoRecentMealsRef=useRef(demoRecentMeals);demoRecentMealsRef.current=demoRecentMeals;
  const customerLocalSnapshot=():CustomerLocalSnapshot=>({cart:cartRef.current,cartRevision:cartRevisionRef.current,demoRecentIds:demoRecentIdsRef.current,demoRecentMeals:demoRecentMealsRef.current});
  const queueCustomerLocalSave=(userId:string|null,snapshot=customerLocalSnapshot())=>{
    storageWriteQueue.current=storageWriteQueue.current.catch(()=>{}).then(()=>saveCustomerLocalState(AsyncStorage,userId,snapshot)).catch(()=>{});
    return storageWriteQueue.current;
  };
  const updateEmail=(value:string)=>{emailEdited.current=true;setEmail(value);};
  const pendingStorageKey=(userId:string)=>`cena.customer.pending-checkout.v1.${userId}`;
  const idempotencyStorageKey=(userId:string)=>`cena.customer.idempotency.v1.${userId}`;
  const bumpCartRevision=()=>{const next=`${Date.now()}-${Math.random().toString(36).slice(2,10)}`;cartRevisionRef.current=next;setCartRevision(next);};
  const menuRequest=useRef(0);
  const bagRequest=useRef(0);
  const idempotency=useRef({ fingerprint:'', key:'' });
  const submitting=useRef(false);
  const profileName=authUserId&&savedName?.userId===authUserId?savedName.name:'';
  const greeting=profileName?`Welcome back, ${profileName}`:'Welcome back';
  const profileInitial=Array.from(profileName)[0]?.toLocaleUpperCase();
  const updateHomeScroll=(event:NativeSyntheticEvent<NativeScrollEvent>)=>{
    if(reduceMotion)return;
    const offset=Math.max(0,event.nativeEvent.contentOffset.y);
    homeScrollY.setValue(offset);
    const collapsed=offset>=welcomeFadeEnd;
    if(collapsedRef.current!==collapsed){
      collapsedRef.current=collapsed;
      setWelcomeCollapsed(collapsed);
    }
  };
  useEffect(()=>{
    if(tab==='Home')return;
    homeScrollY.setValue(0);
    collapsedRef.current=false;
    setWelcomeCollapsed(false);
  },[tab,homeScrollY]);
  useEffect(()=>{
    if(!authUserId)return;
    let active=true;
    void loadCustomerDisplayName(authUserId).then(name=>{
      if(active&&currentAuthUserId.current===authUserId)setSavedName({userId:authUserId,name});
    }).catch(()=>{});
    return ()=>{active=false;};
  },[authUserId,profileRevision]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!supabase)return;
    let request=0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      clearTimeout(pending);
      const current=++request;
      const isInitialAuthEvent=initialAuthEvent.current;
      initialAuthEvent.current=false;
      setAuthenticated(Boolean(session));
      const nextUserId=session?.user.id??null;
      if(currentAuthUserId.current!==nextUserId){
         setSavedName(null);
         const previousUserId=currentAuthUserId.current;
         const previousStorageOwner=storageOwnerRef.current;
         if(previousStorageOwner!==undefined)void queueCustomerLocalSave(previousStorageOwner,customerLocalSnapshot());
         const isGuestSignIn=Boolean(nextUserId)&&!previousUserId&&!isInitialAuthEvent;
         const liveGuestBag=cartRef.current;
         guestBagToAdopt.current=isGuestSignIn&&Object.keys(liveGuestBag).length>0
           ?{snapshot:customerLocalSnapshot(),checkoutInProgress:flowRef.current==='contact'}:null;
         storageOwnerRef.current=undefined;
         setHydrated(false);
         if(!guestBagToAdopt.current){
           cartRef.current={};setCart({});cartRevisionRef.current='';setCartRevision('');
           setDemoRecentIds([]);setDemoRecentMeals([]);
         }
         if(previousUserId){
           setDisplayName('');setPhone('');setEquipment([]);setAnalyticsConsented(false);
           setTermsAccepted(false);
         }else if(event==='SIGNED_OUT'){
           setDisplayName('');setPhone('');setEquipment([]);setAnalyticsConsented(false);
           setTermsAccepted(false);
         }
        currentAuthUserId.current=nextUserId;
        if(!isInitialAuthEvent)bumpCartRevision();
         if(guestBagToAdopt.current)guestBagToAdopt.current.snapshot={...guestBagToAdopt.current.snapshot,cartRevision:cartRevisionRef.current};
        setCheckout(null);setPaymentStatus(null);setShowCheckoutRecovery(false);
        setQuote(null);setQuoteError('');setQuoteRecovery(null);
        setBackendOrders([]);
        setCompletedItems([]);setCompletedTotal(0);
        idempotency.current={fingerprint:'',key:''};
      }
      setAuthUserId(nextUserId);
       if(isInitialAuthEvent)setAuthResolved(true);
      sessionEmail.current=session?.user.email??null;
      if(event==='SIGNED_OUT'){emailEdited.current=false;setEmail('');}
      else if(session?.user.email&&(event==='SIGNED_IN'||(storageHydrated.current&&!emailEdited.current))){emailEdited.current=false;setEmail(session.user.email);}
      if(nextUserId){
        pending=setTimeout(()=>void fetchOrderHistory(nextUserId).then(history=>{
          if(current===request&&!history.error)setBackendOrders(history.data??[]);
        }).catch(()=>{}),0);
      }else setBackendOrders([]);
    });
    return ()=>{request++;clearTimeout(pending);subscription.unsubscribe();};
  },[]);
  useEffect(()=>{
    if(!authResolved)return;
    const generation=++storageLoadGeneration.current;
    let active=true;
    setHydrated(false);
    void (async()=>{
      await storageWriteQueue.current.catch(()=>{});
      const owner=authUserId;
      const saved=await loadCustomerLocalState(AsyncStorage,owner);
      if(!active||generation!==storageLoadGeneration.current||currentAuthUserId.current!==owner)return;
      const guest=owner?guestBagToAdopt.current:null;
      const adoptGuest=Boolean(guest&&(guest.checkoutInProgress||Object.keys(saved.cart).length===0));
      if(adoptGuest&&guest){
        const adopted={...guest.snapshot,demoRecentIds:[],demoRecentMeals:[]};
        await queueCustomerLocalSave(owner,adopted);
        if(!active||generation!==storageLoadGeneration.current||currentAuthUserId.current!==owner)return;
        setCart(adopted.cart as typeof cart);
        cartRevisionRef.current=adopted.cartRevision;setCartRevision(adopted.cartRevision);
      }else{
        setCart(saved.cart as typeof cart);
        cartRevisionRef.current=saved.cartRevision;setCartRevision(saved.cartRevision);
      }
      setDemoRecentIds(saved.demoRecentIds);setDemoRecentMeals(saved.demoRecentMeals);
      storageOwnerRef.current=owner;
      if(owner)guestBagToAdopt.current=null;
      storageHydrated.current=true;
      if(sessionEmail.current&&!emailEdited.current)setEmail(sessionEmail.current);
      setHydrated(true);
    })().catch(()=>{
      if(!active||generation!==storageLoadGeneration.current||currentAuthUserId.current!==authUserId)return;
      storageOwnerRef.current=authUserId;
      storageHydrated.current=true;
      setHydrated(true);
    });
    return()=>{active=false;};
  },[authResolved,authUserId]);
  useEffect(()=>{if(!hydrated||!authUserId)return;let active=true;AsyncStorage.getItem(pendingStorageKey(authUserId)).then(raw=>{if(!active||!raw)return;const pending=JSON.parse(raw);if(pending.ownerUserId===authUserId&&typeof pending.orderId==='string'&&typeof pending.url==='string'&&isTrustedCheckoutURL(pending.url)){setCheckout(pending);setPaymentStatus('pending');setShowCheckoutRecovery(true);}}).catch(()=>{});return()=>{active=false;};},[hydrated,authUserId]);
  useEffect(()=>{
    if(!hydrated||storageOwnerRef.current!==authUserId)return;
    void queueCustomerLocalSave(authUserId,{cart,cartRevision,demoRecentIds,demoRecentMeals});
  },[cart,cartRevision,demoRecentIds,demoRecentMeals,hydrated,authUserId]);
  const confirmPaidCheckout=async(pending:NonNullable<typeof checkout>)=>{
    if(currentAuthUserId.current!==pending.ownerUserId)return;
    if(paidCheckout.current===pending.orderId)return;
    paidCheckout.current=pending.orderId;
    const history=await fetchOrderHistory(pending.ownerUserId).catch(()=>({data:null}));
    if(currentAuthUserId.current!==pending.ownerUserId){paidCheckout.current=null;return;}
    if(history.data)setBackendOrders(history.data as any[]);
    await Promise.all([
      AsyncStorage.removeItem(pendingStorageKey(pending.ownerUserId)).catch(()=>{}),
      AsyncStorage.removeItem(idempotencyStorageKey(pending.ownerUserId)).catch(()=>{}),
    ]);
    if(currentAuthUserId.current!==pending.ownerUserId){paidCheckout.current=null;return;}
    const purchased=pending.items??Object.values(cart).map(({meal,qty})=>({meal,qty}));
    const sameBag=pending.cartRevision!==undefined&&cartRevisionRef.current===pending.cartRevision;
    if(sameBag)setCart(current=>{
      if(currentAuthUserId.current!==pending.ownerUserId||cartRevisionRef.current!==pending.cartRevision)return current;
      const next={...current};
      for(const item of purchased){
        const existing=next[item.meal.id];
        if(!existing||existing.restaurantId!==pending.restaurantId)continue;
        const remaining=existing.qty-item.qty;
        if(remaining<=0)delete next[item.meal.id];
        else next[item.meal.id]={...existing,qty:remaining};
      }
      return next;
    });
    if(currentAuthUserId.current!==pending.ownerUserId){paidCheckout.current=null;return;}
    setPaymentStatus('paid');
    setCompletedItems(purchased);
    setCompletedTotal(pending.total??subtotal);
    if(active&&active.id===pending.restaurantId&&sameBag){setFlow('done');}
    else {setTab('Orders');setNotice({title:'Payment confirmed',message:'Your paid pickup order is in Orders with its pickup time and prep steps.'});}
    setCheckout(null);setShowCheckoutRecovery(false);
    setPaymentStatus(null);
    idempotency.current={fingerprint:'',key:''};
  };
  const resolveRefundedCheckout=async(pending:NonNullable<typeof checkout>)=>{
    if(currentAuthUserId.current!==pending.ownerUserId)return;
    await Promise.all([
      AsyncStorage.removeItem(pendingStorageKey(pending.ownerUserId)).catch(()=>{}),
      AsyncStorage.removeItem(idempotencyStorageKey(pending.ownerUserId)).catch(()=>{}),
    ]);
    if(currentAuthUserId.current!==pending.ownerUserId)return;
    idempotency.current={fingerprint:'',key:''};
    setCheckout(null);setShowCheckoutRecovery(false);setPaymentStatus('refunded');
    const history=await fetchOrderHistory(pending.ownerUserId).catch(()=>({data:null}));
    if(currentAuthUserId.current!==pending.ownerUserId)return;
    if(history.data)setBackendOrders(history.data as any[]);
    setNotice({title:'Payment refunded',message:'This order was refunded. It will remain in Orders with its refund status.'});
  };
  const refreshPaymentStatus=async(pending=checkout)=>{
    if(!pending||checkingPayment.current)return;
    checkingPayment.current=true;
    try{
      const status=await fetchCheckoutStatus(pending.orderId);
      if(currentAuthUserId.current!==pending.ownerUserId)return;
      setPaymentStatus(status);
      if(status==='paid')await confirmPaidCheckout(pending);
      else if(status==='refunded')await resolveRefundedCheckout(pending);
      else if(status==='expired'||status==='failed'){
        await Promise.all([
          AsyncStorage.removeItem(pendingStorageKey(pending.ownerUserId)).catch(()=>{}),
          AsyncStorage.removeItem(idempotencyStorageKey(pending.ownerUserId)).catch(()=>{}),
        ]);
        if(currentAuthUserId.current!==pending.ownerUserId)return;
        idempotency.current={fingerprint:'',key:''};
        setCheckout(null);
      }
    }catch{ /* keep the payment pending; the customer can retry the status check */ }
    finally{checkingPayment.current=false;}
  };
  const cancelPendingPayment=async()=>{
    if(!checkout)return;
    try{
      const result=await cancelCheckout(checkout.orderId);
      if(currentAuthUserId.current!==checkout.ownerUserId)return;
      if(result==='paid'||result==='refunded'){await refreshPaymentStatus(checkout);return;}
      if(result!=='cancelled'&&result!=='expired'&&result!=='failed')throw new Error('The checkout is still active.');
      await Promise.all([
        AsyncStorage.removeItem(pendingStorageKey(checkout.ownerUserId)).catch(()=>{}),
        AsyncStorage.removeItem(idempotencyStorageKey(checkout.ownerUserId)).catch(()=>{}),
      ]);
      if(currentAuthUserId.current!==checkout.ownerUserId)return;
      idempotency.current={fingerprint:'',key:''};
      setPaymentStatus(result);
      setCheckout(null);
    }catch(error){setNotice({title:'Couldn’t cancel checkout',message:error instanceof Error?error.message:'The payment session may still be active. Check its status and try again.'});}
  };
  useEffect(()=>{
    if(!hydrated||!checkout)return;
    const timer=setInterval(()=>void refreshPaymentStatus(checkout),3000);
    const sub=AppState.addEventListener('change',state=>{if(state==='active')void refreshPaymentStatus(checkout);});
    return()=>{clearInterval(timer);sub.remove();};
  },[checkout,hydrated]);
  useEffect(()=>{
    if(!supabase||!authUserId||tab!=='Orders'||active)return;
    let disposed=false;
    let requesting=false;
    const refresh=async()=>{
      if(requesting||currentAuthUserId.current!==authUserId)return;
      requesting=true;
      try{
        const {data}=await fetchOrderHistory(authUserId);
        if(!disposed&&currentAuthUserId.current===authUserId&&data)setBackendOrders(data);
      }catch{ /* Keep the most recent history while the connection recovers. */ }
      finally{requesting=false;}
    };
    void refresh();
    const timer=setInterval(()=>{if(AppState.currentState==='active')void refresh();},30_000);
    const subscription=AppState.addEventListener('change',state=>{if(state==='active')void refresh();});
    return()=>{disposed=true;clearInterval(timer);subscription.remove();};
  },[authUserId,tab,active]);
  useEffect(()=>{if(supabase&&analyticsConsented&&query.trim()){const timer=setTimeout(()=>void trackEvent('search',undefined,{query_length:query.trim().length}),700);return ()=>clearTimeout(timer);}},[query,analyticsConsented]);
  const cartCount=Object.values(cart).reduce((n,x)=>n+x.qty,0), subtotal=Object.values(cart).reduce((n,x)=>n+x.qty*x.meal.price,0);
  const visibleOrders=useMemo(()=>backendOrders.filter(order=>
    (['pay_at_pickup','paid'].includes(order.payment_status)&&['placed','accepted','preparing','ready','completed'].includes(order.status))
    ||(order.payment_method==='stripe_checkout'&&order.payment_status==='refunded'&&order.status==='cancelled')
  ),[backendOrders]);
  const reorderOrders=useMemo(()=>visibleOrders.filter(order=>['pay_at_pickup','paid'].includes(order.payment_status)&&['placed','accepted','preparing','ready','completed'].includes(order.status)),[visibleOrders]);
  const eligibleSlots=active?.pickupSlots?.filter(x=>Date.parse(x.cutoffAt)>now&&Date.parse(x.startsAt)>=now+checkoutLeadMs&&Object.values(cart).every(item=>!!item.meal.backendItemId&&(x.remaining[item.meal.backendItemId]||0)>=item.qty));
  const selectedPickup=eligibleSlots?.find(x=>dayOffset(x.startsAt,active?.timezone)===date&&formatTime(x.startsAt,active?.timezone)===slot);
  const quoteItems=Object.values(cart).map(item=>({item_id:item.meal.backendItemId||item.meal.id,quantity:item.qty}));
  const currentQuoteKey=active?.backendId&&selectedPickup?quoteKey(active.backendId,selectedPickup.id,quoteItems,promoCode):'';
  const currentQuoteKeyRef=useRef(currentQuoteKey);currentQuoteKeyRef.current=currentQuoteKey;
  const quoteMatches=Boolean(quote&&currentQuoteKey&&quote.fingerprint===currentQuoteKey);
  useEffect(()=>{
    if(!supabase||!authenticated||!authUserId||flow!=='contact'||checkout||promoCode.trim()||!active?.backendId||!selectedPickup||!currentQuoteKey||quoteMatches)return;
    const requestKey=`${authUserId}:${currentQuoteKey}`;
    if(quoteFlight.current===requestKey)return;
    quoteFlight.current=requestKey;
    let cancelled=false;
    setQuoteLoading(true);
    setQuoteError('');
    void quoteCheckout({restaurantId:active.backendId,slotId:selectedPickup.id,items:quoteItems,promoCode:''})
      .then(data=>{
          if(cancelled||currentAuthUserId.current!==authUserId||currentQuoteKeyRef.current!==currentQuoteKey||flowRef.current!=='contact')return;
        setQuote({data,fingerprint:currentQuoteKey});
        setQuoteError('');
        setQuoteRecovery(null);
      })
      .catch(error=>{
        if(cancelled||currentAuthUserId.current!==authUserId||currentQuoteKeyRef.current!==currentQuoteKey||flowRef.current!=='contact')return;
        const rejection=knownCheckoutRejection(error);
        if(rejection){
          setQuote(current=>current?.fingerprint===currentQuoteKey?null:current);
          setQuoteError(rejection.message);setQuoteRecovery(rejection.reason);
        }else setQuoteError('Couldn’t check this total. Please try again.');
      })
      .finally(()=>{
        if(quoteFlight.current===requestKey){quoteFlight.current=null;setQuoteLoading(false);}
      });
    return()=>{
      cancelled=true;
      if(quoteFlight.current===requestKey){quoteFlight.current=null;setQuoteLoading(false);}
    };
  },[authenticated,authUserId,flow,checkout?.orderId,promoCode,active?.backendId,selectedPickup?.id,currentQuoteKey,quoteMatches]);
  const recentIds=useMemo(() => supabase
    ? [...new Set<string>(reorderOrders.map(order=>order.restaurant_id))].slice(0,20)
    : demoRecentIds, [reorderOrders,demoRecentIds]);
  const fromCity=locationLabel==='From San Francisco';

  async function usePickupLocation() {
    if (locating) return;
    setLocating(true);
    try {
      const permission=await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error('Location permission was declined.');
      const position=await Location.getCurrentPositionAsync({accuracy:Location.Accuracy.Balanced});
      setOrigin({
        latitude:Math.round(position.coords.latitude*100)/100,
        longitude:Math.round(position.coords.longitude*100)/100,
      });
      setLocationLabel('Current location');
      setShowLocation(false);
    } catch {
      setNotice({title:'Using San Francisco',message:'Cena can use your approximate location if you allow it in your device or browser settings.'});
    } finally {
      setLocating(false);
    }
  }
  const add=(meal:Meal,qty=1,options='')=>{
    if(!hydrated)return;
    if(checkout){setNotice({title:'Finish this checkout first',message:'Complete or cancel the pending payment before changing your bag.'});return;}
    if(!active)return;
    const restaurantId=active.id;
    const current=Object.values(cart)[0]?.restaurantId;
    if(current&&current!==restaurantId){setNotice({title:'One kitchen at a time',message:'Finish this bag before starting an order from another kitchen.'});return;}
    if(!cart[meal.id]&&Object.keys(cart).length>=30){setNotice({title:'Your bag is full',message:'A pickup order can include up to 30 different meal kits.'});return;}
    bumpCartRevision();
    setQuote(null);setQuoteError('');setQuoteRecovery(null);
    setCart(c=>({...c,[meal.id]:{meal,qty:Math.min(50,(c[meal.id]?.qty||0)+qty),options:options||c[meal.id]?.options||'',restaurantId}}));
  };
  const changeQty=(id:string,d:number)=>{
    if(!hydrated)return;
    if(checkout)return;
    if(!cart[id])return;
    bumpCartRevision();
    setQuote(null);setQuoteError('');setQuoteRecovery(null);
    bagRequest.current++;
    setCheckingBag(false);
    setCart(current=>{
      const item=current[id];
      if(!item)return current;
      const next={...current};
      const qty=item.qty+d;
      if(qty<=0)delete next[id];
      else next[id]={...item,qty:d>0?Math.min(50,qty):qty};
      return next;
    });
  };
  const openKitchen=async (kitchen:Kitchen)=>{
    const request=++menuRequest.current;
    setActive(kitchen);
    setFlow('menu');
    setCurb(false);
    setSelected(null);
    setMenuLoading(Boolean(kitchen.backendId));
    if(supabase&&analyticsConsented&&kitchen.backendId)void trackEvent('restaurant_view',kitchen.backendId,{});
    try {
      const loaded=await loadKitchenMenu(kitchen);
      if(request!==menuRequest.current)return;
      setActive(loaded);
      const first=loaded.pickupSlots?.find(slot=>Date.parse(slot.cutoffAt)>Date.now()&&Date.parse(slot.startsAt)>=Date.now()+checkoutLeadMs);
      if(first){
        setDate(dayOffset(first.startsAt,loaded.timezone));
        setSlot(formatTime(first.startsAt,loaded.timezone));
      }else if(!loaded.backendId){
        setDate(1);
        setSlot('5:30 PM');
      }
    }catch{
      if(request===menuRequest.current)setNotice({title:'Couldn’t load this menu',message:'Go back and reopen the kitchen to try again.'});
    }finally{
      if(request===menuRequest.current)setMenuLoading(false);
    }
  };
  const closeKitchen=()=>{
    menuRequest.current++;
    setMenuLoading(false);
    setActive(null);
    setSelected(null);
  };
  const navigate=(destination:Tab)=>{
    bagRequest.current++;
    setCheckingBag(false);
    if(active)closeKitchen();
    setTab(destination);
  };
  async function continueBag() {
    const lines: BagLine[]=Object.values(cart);
    if(!hydrated||checkingBag||!lines.length)return;
    const request=++bagRequest.current;
    setCheckingBag(true);
    try {
      const kitchen=await fetchKitchenBySlug(lines[0].restaurantId);
      const loaded=kitchen?await loadKitchenMenu(kitchen):null;
      if(request!==bagRequest.current)return;
      const meals=new Map(loaded?.meals.map(meal=>[meal.id,meal]));
      if(!loaded||lines.some(item=>!meals.has(item.meal.id))){
        setNotice({title:'A meal kit is no longer available',message:'Remove unavailable items from your bag and try again.'});
        return;
      }
      const first=loaded.pickupSlots?.find(window=>Date.parse(window.cutoffAt)>Date.now()&&Date.parse(window.startsAt)>=Date.now()+checkoutLeadMs&&lines.every(item=>(window.remaining[item.meal.id]??0)>=item.qty));
      if(loaded.backendId&&!first){
        setNotice({title:'No pickup time fits this bag',message:'Try a smaller quantity or remove a kit to see available pickup times.'});
        return;
      }
      setCart(current=>Object.fromEntries(Object.entries(current).map(([id,item])=>[id,{...item,meal:meals.get(id)??item.meal}])));
      setDate(first?dayOffset(first.startsAt,loaded.timezone):1);
      setSlot(first?formatTime(first.startsAt,loaded.timezone):'5:30 PM');
      setCurb(false);
      setPaymentStatus(null);
      setQuote(null);setQuoteError('');setQuoteRecovery(null);
      setActive(loaded);
      setFlow('date');
    }catch{
      if(request===bagRequest.current)setNotice({title:'Pickup availability couldn’t load',message:'Check your connection and try again.'});
    }finally{
      if(request===bagRequest.current)setCheckingBag(false);
    }
  }
  const openMeal=(m:Meal)=>{setSelectedQuantity(1);setSelectedOptions([]);setSelected(m);if(supabase&&analyticsConsented&&active?.backendId)void trackEvent('item_view',active.backendId,m.backendItemId?{item_id:m.backendItemId}:{});};
  const openPolicy=async(path:'consumer-terms'|'privacy-policy')=>{const base=process.env.EXPO_PUBLIC_CENA_SITE_URL;if(base){try{await Linking.openURL(`${base.replace(/\/$/,'')}/${path==='consumer-terms'?'terms.html':'privacy.html'}`);return;}catch{}}setNotice({title:path==='consumer-terms'?'Consumer terms':'Privacy policy',message:path==='consumer-terms'?'Orders reserve restaurant-prepared items for pickup after secure payment. Restaurants are responsible for menu and allergen details.':`We use your email and optional phone to link and manage pickup orders. Anonymous browsing analytics are optional and off until you choose to share them.`});};
  const closeLocationPicker=()=>{setShowLocation(false);if(Platform.OS==='web')requestAnimationFrame(()=>pickupAreaButtonRef.current?.focus?.());};
  const closeFlow=()=>{if(flow==='time')setFlow('date');else if(flow==='contact')setFlow('time');else closeKitchen();};
  const sendCheckoutCode=async()=>{
    const requestedEmail=checkoutEmailRef.current.trim().toLowerCase();
    if(Date.now()<otpResendAt)return;
    setOtpBusy(true);
    setOtpFeedback('');
    try{
      const {error}=await sendEmailCode(requestedEmail);
      if(checkoutEmailRef.current.trim().toLowerCase()!==requestedEmail||flowRef.current!=='contact'||currentAuthUserId.current)return;
      if(error){
        if('status' in error&&error.status===429){
          setOtpResendAt(Date.now()+60_000);
          setOtpFeedback('Please wait a minute before requesting another code.');
        }else{
          setOtpFeedback('Couldn’t send your code. Check the email address and try again.');
        }
        return;
      }
      setOtpSent(true);
      setOtpCode('');
      setOtpResendAt(Date.now()+60_000);
      setOtpFeedback('Check your email for a six-digit sign-in code.');
    }catch{
      if(checkoutEmailRef.current.trim().toLowerCase()===requestedEmail&&flowRef.current==='contact')setOtpFeedback('Couldn’t send your code. Check your connection and try again.');
    }finally{
      setOtpBusy(false);
    }
  };
  const resendCheckoutCode=async()=>{
    if(submitting.current)return;
    submitting.current=true;
    try{await sendCheckoutCode();}
    finally{submitting.current=false;}
  };
  const recoverKnownCheckoutError=()=>{
    const reason=quoteRecovery;
    setQuoteRecovery(null);setQuoteError('');setQuote(null);
    if(reason==='promo_unavailable'||(reason==='order_total_too_low'&&promoCode.trim())){
      setPromoCode('');
      return;
    }
    if(reason==='curbside_unavailable'){
      setCurb(false);
      return;
    }
    closeKitchen();setTab('Bag');
  };
  const place=async()=>{
    if(submitting.current)return;
    submitting.current=true;
    try{
    if(checkout){
      await Linking.openURL(checkout.url);
      void refreshPaymentStatus(checkout);
      return;
    }
    let sessionAlreadySignedIn=authenticated;
    if(supabase){const currentSession=await supabase.auth.getSession();const signedInEmail=currentSession.data.session?.user.email;if(signedInEmail){sessionAlreadySignedIn=true;sessionEmail.current=signedInEmail;emailEdited.current=false;setEmail(signedInEmail);setAuthenticated(true);}}
    const cartKitchen=Object.values(cart)[0]?.restaurantId;
    if(cartKitchen&&active&&cartKitchen!==active.id){setNotice({title:'Your bag belongs to another kitchen',message:'Return to that kitchen to finish this pickup order.'});return;}
    if(supabase){
      if(!sessionAlreadySignedIn){
        if(!otpSent){await sendCheckoutCode();return;}
        if(!/^[0-9]{6}$/.test(otpCode))return;
        const verifyEmail=checkoutEmailRef.current.trim().toLowerCase();
        setOtpBusy(true);
        setOtpFeedback('');
        try{
          const {error}=await verifyEmailCode(verifyEmail,otpCode);
          if(error){
            if(checkoutEmailRef.current.trim().toLowerCase()===verifyEmail&&flowRef.current==='contact'){
              setOtpFeedback('status' in error&&error.status===429
                ?'Too many attempts. Wait a minute and try again.'
                :'That code didn’t work. Check the digits or request a new code.');
            }
            return;
          }
        }catch{
          if(checkoutEmailRef.current.trim().toLowerCase()===verifyEmail&&flowRef.current==='contact')setOtpFeedback('Couldn’t verify your code. Check your connection and try again.');
          return;
        }finally{setOtpBusy(false);}
        if(flowRef.current!=='contact'||checkoutEmailRef.current.trim().toLowerCase()!==verifyEmail)return;
      }
      const selectedSlot=selectedPickup;
      if(!active?.backendId||!selectedSlot||Object.values(cart).some(x=>!x.meal.backendItemId)||Object.values(cart).some(x=>selectedSlot.remaining[x.meal.backendItemId!]<(x.qty||0))){setNotice({title:'Pickup availability changed',message:'One or more meal kits are no longer available for that window. Choose another time or update your bag.'});return;}
      if(curb&&(!vehicleMake.trim()||!vehicleModel.trim()||!vehicleColor.trim())){setNotice({title:'Add your vehicle details',message:'Curbside pickup needs your vehicle make, model, and color.'});return;}
      const orderInput={restaurantId:active.backendId,slotId:selectedSlot.id,pickupMode:curb?'curbside' as const:'counter' as const,vehicle:curb?{make:vehicleMake,model:vehicleModel,color:vehicleColor}:undefined,items:Object.values(cart).map(x=>({item_id:x.meal.backendItemId!,quantity:x.qty}))};
      const requestCartRevision=cartRevisionRef.current;
      const requestItems=Object.values(cart).map(({meal,qty})=>({meal,qty}));
      const checkoutSession=await supabase.auth.getSession();
      const ownerUserId=checkoutSession.data.session?.user.id;
      if(!ownerUserId){setNotice({title:'Sign in again',message:'Your secure session expired. Sign in to continue checkout.'});return;}
      if(currentAuthUserId.current!==ownerUserId)return;
      const normalizedPromo=promoCode.trim().toUpperCase();
      const fingerprint=quoteKey(orderInput.restaurantId,orderInput.slotId,orderInput.items,normalizedPromo);
      if(!quote||quote.fingerprint!==fingerprint){
        const requestKey=`${ownerUserId}:${fingerprint}`;
        if(quoteFlight.current===requestKey)return;
        quoteFlight.current=requestKey;
        setQuoteLoading(true);setQuoteError('');setQuoteRecovery(null);
        try{
          const data=await quoteCheckout({restaurantId:orderInput.restaurantId,slotId:orderInput.slotId,items:orderInput.items,promoCode:normalizedPromo});
          if(currentAuthUserId.current!==ownerUserId||currentQuoteKeyRef.current!==fingerprint||flowRef.current!=='contact')return;
          setQuote({data,fingerprint});
          setPromoCode(data.promo_code??'');
        }catch(error){
          if(currentAuthUserId.current!==ownerUserId||currentQuoteKeyRef.current!==fingerprint||flowRef.current!=='contact')return;
          const rejection=knownCheckoutRejection(error);
          if(rejection){
            setQuote(current=>current?.fingerprint===fingerprint?null:current);
            setQuoteError(rejection.message);setQuoteRecovery(rejection.reason);
          }else setQuoteError('Couldn’t check this total. Please try again.');
        }
        finally{if(quoteFlight.current===requestKey){quoteFlight.current=null;setQuoteLoading(false);}}
        return;
      }
      const checkoutFingerprint=JSON.stringify({orderInput,promoCode:normalizedPromo,expectedAmountCents:quote.data.amount_cents});
      if(idempotency.current.fingerprint!==checkoutFingerprint){
        let saved:{fingerprint:string;key:string}|null=null;
        try{const raw=await AsyncStorage.getItem(idempotencyStorageKey(ownerUserId));if(raw)saved=JSON.parse(raw);}catch{}
        idempotency.current=saved?.fingerprint===checkoutFingerprint?saved:{fingerprint:checkoutFingerprint,key:`cena-${Date.now()}-${Math.random().toString(36).slice(2,8)}`};
        await AsyncStorage.setItem(idempotencyStorageKey(ownerUserId),JSON.stringify(idempotency.current));
      }
      if(currentAuthUserId.current!==ownerUserId||currentQuoteKeyRef.current!==fingerprint||flowRef.current!=='contact')return;
      let session;
      try{session=await createCheckout({...orderInput,idempotencyKey:idempotency.current.key,promoCode:normalizedPromo||undefined,expectedAmountCents:quote.data.amount_cents});}
      catch(error){
        if(currentAuthUserId.current!==ownerUserId)return;
        if(error instanceof CheckoutRequestError&&error.status===409&&error.checkoutStatus==='refunded'&&error.orderId){
          const checkoutState=await fetchCheckoutStatus(error.orderId);
          if(currentAuthUserId.current!==ownerUserId)return;
          const prior={orderId:error.orderId,url:'',restaurantId:active.id,date,slot,email,total:quote.data.amount_cents/100,ownerUserId,cartRevision:requestCartRevision,items:requestItems};
          if(checkoutState==='refunded')await resolveRefundedCheckout(prior);
          else if(checkoutState==='paid')await confirmPaidCheckout(prior);
          else setNotice({title:'Checking your payment',message:'The previous order state is being confirmed. Your bag is saved and won’t be resubmitted yet.'});
          return;
        }
        if(error instanceof CheckoutRequestError&&error.status===409&&(error.checkoutStatus==='expired'||error.checkoutStatus==='failed')){
          await AsyncStorage.removeItem(idempotencyStorageKey(ownerUserId)).catch(()=>{});
          if(currentAuthUserId.current!==ownerUserId)return;
          idempotency.current={fingerprint:'',key:''};setPaymentStatus(error.checkoutStatus);setQuote(null);
          setNotice({title:'Payment session ended',message:'Your bag is saved. Choose another pickup time or start a new secure checkout.'});return;
        }
        if(error instanceof CheckoutRequestError&&error.status===409){if(currentQuoteKeyRef.current!==fingerprint||flowRef.current!=='contact')return;setQuote(current=>current?.fingerprint===fingerprint?null:current);setQuoteError(error.message||'Your total changed. Check the updated total before continuing.');setQuoteRecovery(null);return;}
        const rejection=knownCheckoutRejection(error);
        if(rejection){
          if(currentQuoteKeyRef.current!==fingerprint||flowRef.current!=='contact')return;
          setQuote(current=>current?.fingerprint===fingerprint?null:current);
          setQuoteError(rejection.message);
          setQuoteRecovery(rejection.reason);
          return;
        }
        throw error;
      }
      if('status' in session){
        if(currentAuthUserId.current!==ownerUserId)return;
        const confirmed=await fetchCheckoutStatus(session.order_id);
        if(currentAuthUserId.current!==ownerUserId)return;
        if(confirmed==='paid')await confirmPaidCheckout({orderId:session.order_id,url:'',restaurantId:active.id,date,slot,email,total:quote.data.amount_cents/100,ownerUserId,cartRevision:requestCartRevision,items:requestItems});
        else if(confirmed==='refunded')await resolveRefundedCheckout({orderId:session.order_id,url:'',restaurantId:active.id,date,slot,email,total:quote.data.amount_cents/100,ownerUserId,cartRevision:requestCartRevision,items:requestItems});
        else if(confirmed==='expired'||confirmed==='failed'){
          await AsyncStorage.removeItem(idempotencyStorageKey(ownerUserId)).catch(()=>{});
          if(currentAuthUserId.current!==ownerUserId)return;
          idempotency.current={fingerprint:'',key:''};setPaymentStatus(confirmed);
          setNotice({title:'Payment session ended',message:'Your bag is saved. Choose another pickup time or start a new secure checkout.'});
        }else setNotice({title:'Checking your payment',message:'Your bag is saved. Cena is still confirming the previous checkout; try checking again shortly.'});
        return;
      }
      const checkoutUrl=session.checkout_url;
      const pending={orderId:session.order_id,url:checkoutUrl,restaurantId:active.id,date,slot,email,total:quote.data.amount_cents/100,ownerUserId,cartRevision:requestCartRevision,items:requestItems};
      await AsyncStorage.setItem(pendingStorageKey(ownerUserId),JSON.stringify(pending));
      if(currentAuthUserId.current!==ownerUserId)return;
      setCheckout(pending);setPaymentStatus('pending');setShowCheckoutRecovery(true);
      try{await Linking.openURL(checkoutUrl);}catch{setNotice({title:'Checkout is ready',message:'Your bag is saved. Open secure checkout to complete payment, then return here to confirm it.'});}
      return;
    }else{
      setNotice({title:'Secure payment unavailable',message:'You can keep browsing, but Cena checkout is not connected in this preview. No order has been placed or charged.'});
      return;
    }
    }catch{
      setNotice({title:'Couldn’t finish checkout',message:'Check your connection and try again.'});
    }finally{
      submitting.current=false;
    }
  };
  const identityBar=<View pointerEvents="box-none" style={[s.topbar,{height:identityHeight,paddingHorizontal:headerSide,gap:safeWidth<390?8:14},tab==='Home'&&{backgroundColor:'transparent',borderBottomWidth:0}]}><View style={s.brand}><LogoText style={s.wordmark}>cena</LogoText><View style={s.logodot}/></View><Pressable ref={pickupAreaButtonRef} accessibilityRole="button" accessibilityLabel={`Change pickup area, ${locationLabel}`}
        onPress={()=>setShowLocation(true)} style={[s.location,{flexShrink:1,minWidth:0}]}>
          <MapPin size={15} color={maroon}/><Text numberOfLines={1} style={[s.locText,{flexShrink:1}]}>{locating?'Finding location…':locationLabel}</Text>
        </Pressable><Pressable accessibilityRole="button" accessibilityLabel="Open account" onPress={()=>navigate('Account')} style={[s.avatar,{flexShrink:0}]}>{profileInitial?<Text numberOfLines={1} style={{fontSize:15,fontWeight:'500',color:maroon}}>{profileInitial}</Text>:<UserRound size={17} color={maroon}/>}</Pressable></View>;
  return <View style={[s.screen,{paddingTop:insets.top,paddingLeft:insets.left,paddingRight:insets.right}]}><View style={{flex:1,width:'100%'}}>
    <View style={{flex:1}} pointerEvents={active||showLocation?'none':'auto'} aria-hidden={Boolean(active||showLocation)}
      {...(Platform.OS==='web'?showLocation?({inert:true} as any):{}:{accessibilityElementsHidden:Boolean(active||showLocation),importantForAccessibility:active||showLocation?'no-hide-descendants':'auto'})}>
      {tab==='Home'?<HomeHeader scrollY={homeScrollY} reduced={reduceMotion} greeting={greeting} collapsed={welcomeCollapsed} side={contentSide} identityHeight={identityHeight} topInset={insets.top}>{identityBar}</HomeHeader>:identityBar}
      <Enter key={tab} reduced={reduceMotion} style={{width:'100%',maxWidth:homeContentMaxWidth,alignSelf:'center'}}>
      {tab==='Home'?<DiscoveryFeed width={contentWidth} side={contentSide} radius={contentRadius}
          query={query} reduced={reduceMotion} origin={origin} fromCity={fromCity} recentIds={recentIds}
          headerHeight={identityHeight+(reduceMotion?0:welcomeHeight)} bottomSpace={navHeight+searchHeight+2*searchGap}
          onScroll={updateHomeScroll} welcome={reduceMotion?<HomeWelcome greeting={greeting}/>:undefined}
      open={kitchen=>void openKitchen(kitchen)}/>:tab==='Orders'?<Orders onRepeat={(k)=>openKitchen(k)} orders={visibleOrders} live={!!supabase}/>:tab==='Bag'?<Bag items={Object.values(cart)} subtotal={subtotal} radius={contentRadius} loading={checkingBag||!hydrated} locked={Boolean(checkout)||!hydrated} bottomNavHeight={navHeight} change={changeQty} remove={id=>changeQty(id,-Infinity)} browse={()=>navigate('Home')} checkout={()=>void continueBag()}/>:<Account
          userId={authUserId} equipment={equipment} setEquipment={setEquipment} analyticsConsented={analyticsConsented}
          setAnalyticsConsented={setAnalyticsConsented} email={email} setEmail={updateEmail} phone={phone} setPhone={setPhone}
          displayName={displayName} setDisplayName={setDisplayName} onProfileSaved={()=>setProfileRevision(current=>current+1)}/>}
      </Enter>
      {tab==='Home'&&!active&&<HomeSearch query={query} setQuery={setQuery} bottom={navHeight+searchGap} radius={contentRadius} side={headerSide} height={searchHeight}/>}
    </View>

    {active&&<View style={[StyleSheet.absoluteFillObject,{zIndex:3,backgroundColor:ivory}]}><Enter key={active.id} reduced={reduceMotion} style={[s.modalPage,{width:'100%',maxWidth:homeContentMaxWidth,alignSelf:'center'}]}><View style={s.modalTop}><Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={closeFlow} style={s.backBtn}><ArrowLeft size={20} color={ink}/></Pressable><LogoText style={s.modalBrand}>cena</LogoText><Pressable accessibilityRole="button" accessibilityLabel="Open bag" onPress={()=>navigate('Bag')}><ShoppingBag size={21} color={maroon}/></Pressable></View>
      {flow==='menu'&&<ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom:120}}>
        <ImageBackground source={kitchenImage(active.image.startsWith("http")?active.id:active.image)} resizeMode="cover" style={[s.restaurantHero,{height:Math.round(contentWidth*9/16)}]}><View style={s.imageShade}/><View style={s.restaurantHeroBottom}><Text style={s.restaurantLabel}>YOUR NEIGHBORHOOD KITCHEN</Text><Text style={s.restaurantName}>{active.name}</Text><Text style={s.restaurantDesc}>{active.cuisine}</Text></View></ImageBackground>
        <View style={s.restaurantMeta}>{active.rating&&<View style={s.metaItem}><Star size={15} color="#C57760" fill="#C57760"/><Text style={s.metaText}>{active.rating} rating</Text></View>}{formatDistance(active.distanceMiles,fromCity)&&<View style={s.metaItem}><MapPin size={15} color={muted}/><Text style={s.metaText}>{formatDistance(active.distanceMiles,fromCity)}</Text></View>}{active.address&&<View style={s.metaItem}><MapPin size={15} color={muted}/><Text style={s.metaText}>{active.address}</Text></View>}</View>
        <View style={{marginHorizontal:18,marginBottom:16}}><PickupCountdown slots={active.pickupSlots} timezone={active.timezone}/></View>
        <View style={s.menuTitleRow}><View><Text style={s.sectionTitle}>Finish-at-home favorites</Text><Text style={s.sectionHint}>Everything you need, already prepped.</Text></View><Text style={s.dealBadge}>~25% OFF</Text></View>
        {menuLoading&&<ActivityIndicator color={maroon} accessibilityLabel="Loading menu"/>}
        {!menuLoading&&!active.meals.length&&<Text style={[s.sectionHint,{marginHorizontal:18}]}>No meal kits are available for pickup at this kitchen right now.</Text>}
        {supabase?(authUserId&&<LiveMenuReorder key={authUserId} userId={authUserId} kitchen={active} add={(m,q)=>add(m,q)}/>):Object.values(recentlyOrdered).some(x=>active.meals.some(m=>m.id in recentlyOrdered))&&<View style={s.reorderBox}><View style={s.reorderIcon}><CircleCheck size={19} color={green}/></View><View style={{flex:1}}><Text accessibilityRole="header" style={s.reorderTitle}>Recent orders</Text><Text style={s.reorderSub}>Previous quantity and preferences are saved.</Text>{active.meals.filter(m=>m.id in recentlyOrdered).map(m=><View key={m.id} style={s.savedOrderRow}><Text style={s.savedOrderName}>{m.name}</Text><Text style={s.savedOrderOpts}>{recentlyOrdered[m.id].qty}× · {recentlyOrdered[m.id].options}</Text><Pressable onPress={()=>add(m,recentlyOrdered[m.id].qty,recentlyOrdered[m.id].options)} style={s.reorderBtn}><Plus size={14} color="#FFF"/><Text style={s.reorderBtnText}>Add usual</Text></Pressable></View>)}</View></View>}
        {active.meals.map(m=><Pressable onPress={()=>openMeal(m)} style={s.mealRow} key={m.id}><View style={s.mealText}><View style={s.mealTags}>{m.tag&&<Text style={s.mealTag}>{m.tag}</Text>}{m.equipment&&!equipment.some(e=>e.toLowerCase()===m.equipment!.toLowerCase())&&<Text style={s.equipmentTag}>NEEDS {m.equipment.toUpperCase()}</Text>}</View><Text style={s.mealName}>{m.name}</Text><Text style={s.mealDesc}>{m.subtitle}</Text><MealPrice meal={m}/>{cart[m.id]&&<Text style={s.inCart}>In your bag · {cart[m.id].qty}</Text>}</View><View><Image source={mealImage(m.image.startsWith("http")?m.id:m.image)} resizeMode="cover" style={s.mealImage}/><Pressable accessibilityRole="button" accessibilityLabel={`Add ${m.name} to bag`} disabled={!hydrated} onPress={event=>{event.stopPropagation();add(m);}} style={s.addBubble}><Plus size={19} color={maroon}/></Pressable></View></Pressable>)}
      </ScrollView>}
      {flow==='date'&&<PickupDate date={date} live={!!active.backendId} slots={eligibleSlots} timezone={active.timezone} address={active.address} setDate={n=>{setQuote(null);setQuoteError('');setQuoteRecovery(null);setDate(n);const first=eligibleSlots?.find(x=>dayOffset(x.startsAt,active.timezone)===n);if(first)setSlot(formatTime(first.startsAt,active.timezone));}} next={()=>{if(active.backendId&&!eligibleSlots?.length){closeKitchen();setTab('Bag');}else setFlow('time');}}/>}
      {flow==='time'&&<PickupTime date={date} live={!!active.backendId} available={eligibleSlots?.filter(x=>dayOffset(x.startsAt,active.timezone)===date)} timezone={active.timezone} address={active.address} slot={slot} setSlot={value=>{setQuote(null);setQuoteError('');setQuoteRecovery(null);setSlot(value);}} curb={curb} setCurb={setCurb} curbsideEnabled={active.curbsideEnabled!==false} editDate={()=>setFlow('date')} next={()=>setFlow(active.backendId&&!eligibleSlots?.some(x=>dayOffset(x.startsAt,active.timezone)===date)?'date':'contact')}/>}
      {flow==='contact'&&<KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[s.checkoutContent,{flexGrow:1}]}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepDone}>2  PICKUP</Text><Text style={s.stepCurrent}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>Add your email for{ '\n' }your pickup order.</Text><Text style={s.checkoutSub}>Your email links this order to your pickup history.</Text><View style={s.inputWrap}><Mail size={18} color={muted}/><TextInput style={s.contactInput} accessibilityLabel="Email address" value={email} editable={!authenticated&&!otpBusy} onChangeText={value=>{updateEmail(value);setOtpSent(false);setOtpCode('');setOtpFeedback('');setOtpResendAt(0);}} keyboardType="email-address" autoCapitalize="none" placeholder="Email address" placeholderTextColor="#A69A94"/></View><View style={s.inputWrap}><Phone size={18} color={muted}/><TextInput accessibilityLabel="Mobile number, optional" style={s.contactInput} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Mobile number (optional)" placeholderTextColor="#A69A94"/></View>{supabase&&<><Text style={s.settingsSection}>DISCOUNT CODE</Text><View style={s.inputWrap}><TextInput accessibilityLabel="Restaurant discount code" style={s.contactInput} value={promoCode} editable={!checkout} onChangeText={value=>{setPromoCode(value);setQuoteError('');setQuoteRecovery(null);}} autoCapitalize="characters" autoCorrect={false} placeholder="Optional restaurant code" placeholderTextColor="#A69A94"/></View><Text style={[s.sectionHint,{marginTop:-6,marginBottom:8}]}>Codes apply to this restaurant. Cena checks the discount before payment.</Text>{quoteError!==''&&<Text accessibilityLiveRegion="polite" style={{fontSize:11,color:"#A1382C",marginBottom:8}}>{quoteError}</Text>}{quoteRecovery&&<Pressable accessibilityRole="button" accessibilityLabel={quoteRecovery==='promo_unavailable'||(quoteRecovery==='order_total_too_low'&&promoCode.trim())?'Remove code and review total':quoteRecovery==='curbside_unavailable'?'Switch to counter pickup':'Return to bag and refresh availability'} onPress={recoverKnownCheckoutError} style={{alignSelf:"flex-start",borderWidth:1,borderColor:"#A1382C",borderRadius:8,paddingHorizontal:12,paddingVertical:9,marginBottom:10}}><Text style={{fontSize:11,color:"#A1382C",fontWeight:'500'}}>{quoteRecovery==='promo_unavailable'||(quoteRecovery==='order_total_too_low'&&promoCode.trim())?'Remove code and review total':quoteRecovery==='curbside_unavailable'?'Switch to counter pickup':'Return to bag and refresh availability'}</Text></Pressable>}{quoteLoading&&<View style={s.checkoutInfo}><ActivityIndicator color={green}/><Text style={s.checkoutInfoText}>Checking restaurant pricing…</Text></View>}{quoteMatches&&quote&&<View style={[s.orderHistoryCard,{marginBottom:12}]}><View style={s.totalRow}><Text style={s.totalLabel}>Meal kits</Text><Text style={s.totalPrice}>{dollars(quote.data.subtotal_cents/100)}</Text></View>{quote.data.discount_cents>0&&<View style={s.totalRow}><Text style={s.totalLabel}>Discount{quote.data.promo_code?' · '+quote.data.promo_code:''}</Text><Text style={[s.totalPrice,{color:green}]}>−{dollars(quote.data.discount_cents/100)}</Text></View>}<View style={[s.totalRow,{borderTopWidth:1,borderTopColor:line,marginTop:4}]}><Text style={[s.totalLabel,{fontWeight:'500',color:ink}]}>Total due</Text><Text style={s.totalPrice}>{dollars(quote.data.amount_cents/100)}</Text></View></View>}</>}{otpSent&&!authenticated&&<>
        <View style={s.inputWrap}><Mail size={18} color={green}/><TextInput style={s.contactInput} accessibilityLabel="Email sign-in code" value={otpCode} onChangeText={value=>setOtpCode(value.replace(/[^0-9]/g,'').slice(0,6))} autoComplete="one-time-code" keyboardType="number-pad" editable={!otpBusy} placeholder="6-digit email sign-in code" placeholderTextColor="#A69A94"/></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Send a new code" accessibilityHint={now<otpResendAt?`Available in ${Math.ceil((otpResendAt-now)/1000)} seconds.`:'Requests another sign-in code.'} disabled={otpBusy||now<otpResendAt} onPress={()=>void resendCheckoutCode()} style={{alignSelf:'flex-start',minHeight:44,justifyContent:'center'}}>
          <Text style={[s.summaryEdit,(otpBusy||now<otpResendAt)&&{color:muted}]}>{now<otpResendAt?`Send a new code in ${Math.ceil((otpResendAt-now)/1000)}s`:'Send a new code'}</Text>
        </Pressable>
      </>}{!authenticated&&!!otpFeedback&&<Text accessibilityLiveRegion="polite" style={[s.checkoutInfoText,{marginBottom:10}]}>{otpFeedback}</Text>}{curb&&<><Text style={s.settingsSection}>YOUR VEHICLE FOR CURBSIDE</Text><View style={s.inputWrap}><TextInput style={s.contactInput} value={vehicleMake} onChangeText={setVehicleMake} placeholder="Make" placeholderTextColor="#A69A94"/><TextInput style={s.contactInput} value={vehicleModel} onChangeText={setVehicleModel} placeholder="Model" placeholderTextColor="#A69A94"/></View><View style={s.inputWrap}><TextInput style={s.contactInput} value={vehicleColor} onChangeText={setVehicleColor} placeholder="Color" placeholderTextColor="#A69A94"/></View></>}<View style={[s.pickupSummary,{flexWrap:"wrap"}]}><Pressable accessibilityRole="checkbox" accessibilityLabel="Agree to the Consumer Terms and Privacy Policy" aria-checked={termsAccepted} accessibilityState={{checked:termsAccepted}} onPress={()=>setTermsAccepted(!termsAccepted)} hitSlop={12} style={[s.checkbox,termsAccepted&&s.checkboxOn]}>{termsAccepted&&<Check size={14} color="#FFF"/>}</Pressable><Text style={s.checkoutInfoText}>I agree to the</Text><Pressable onPress={()=>openPolicy('consumer-terms')}><Text style={s.summaryEdit}>Consumer Terms</Text></Pressable><Text style={s.checkoutInfoText}>and</Text><Pressable onPress={()=>openPolicy('privacy-policy')}><Text style={s.summaryEdit}>Privacy Policy</Text></Pressable></View><View style={s.checkoutInfo}><PackageCheck size={19} color={green}/><Text style={s.checkoutInfoText}>{supabase?'Secure payment is required to place this pickup order. You will return here to confirm it.':'Secure checkout is unavailable in this preview; browsing is still available.'}</Text></View>{checkout&&<View style={s.checkoutInfo}><PackageCheck size={19} color={green}/><Text style={s.checkoutInfoText}>Payment {paymentStatus==='pending'?'is still processing. Complete payment in secure checkout, then return here.':paymentStatus==='paid'?'confirmed.':`status: ${paymentStatus??'pending'}.`}</Text><Pressable onPress={()=>void refreshPaymentStatus(checkout)}><Text style={s.summaryEdit}>Check</Text></Pressable></View>}{!checkout&&paymentStatus&&<View style={s.checkoutInfo}><Text style={s.checkoutInfoText}>{paymentStatus==='refunded'?'This order was refunded. View the refund in Orders.':paymentStatus==='expired'?'That payment session expired. Your bag is saved; start a new secure checkout.':'Payment did not complete. Your bag is saved; try secure checkout again.'}</Text></View>}<View style={{flex:1}}/><View style={s.pickupSummary}><View style={{flex:1}}><Text style={s.pickupSummaryTitle}>{dateLabel(date,active?.timezone)} · {slot}</Text><Text style={s.pickupSummarySub}>{active?.name||'Pickup kitchen'} · {curb?'Curbside':'Counter pickup'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Edit pickup time" disabled={Boolean(checkout)} onPress={()=>setFlow('time')} hitSlop={10}><Text style={s.summaryEdit}>EDIT</Text></Pressable></View>{!supabase&&<View style={s.totalRow}><Text style={s.totalLabel}>Meal kit total · preview</Text><Text style={s.totalPrice}>{dollars(subtotal)}</Text></View>}<Pressable accessibilityRole="button" onPress={paymentStatus==='refunded'?()=>{closeKitchen();setTab('Orders');}:place} disabled={!checkout&&paymentStatus!=='refunded'&&(otpBusy||quoteLoading||!email.includes('@')||(supabase&&!termsAccepted)||(supabase&&!authenticated&&(otpSent?otpCode.length!==6:now<otpResendAt)))} style={[s.primaryBtn,(!checkout&&paymentStatus!=='refunded'&&(otpBusy||quoteLoading||!email.includes('@')||(supabase&&!termsAccepted)||(supabase&&!authenticated&&(otpSent?otpCode.length!==6:now<otpResendAt))))&&{opacity:.5}]}><Text style={s.primaryBtnText}>{paymentStatus==='refunded'?'View order history':checkout?'Open secure checkout':supabase&&!authenticated&&!otpSent?'Email me a sign-in code':supabase&&!authenticated?'Verify code and continue':!quoteMatches?(promoCode.trim()?'Apply code & review total':'Review total'):'Continue to secure payment · '+dollars(quote!.data.amount_cents/100)}</Text><ChevronRight size={19} color="#FFF"/></Pressable><Text style={s.finePrint}>You will only see order confirmation after payment is verified.</Text></ScrollView></KeyboardAvoidingView>}
      {flow==='done'&&<View style={s.doneView}><View style={s.doneIcon}><Check size={32} color="#FFF"/></View><Text style={s.doneEyebrow}>YOU’RE ALL SET</Text><Text style={s.doneTitle}>Dinner is{ '\n' }in motion.</Text><Text style={s.doneSub}>Your order is linked to {email}. Follow pickup progress from Orders.</Text><View style={s.doneCard}><View style={s.doneCardRow}><CreditCard size={17} color={green}/><Text style={s.doneCardText}>Paid · {dollars(completedTotal)}</Text></View><View style={s.doneCardRow}><CalendarDays size={17} color={maroon}/><Text style={s.doneCardText}>{dateLabel(date,active.timezone)} · {slot}</Text></View><View style={s.doneCardRow}><MapPin size={17} color={maroon}/><Text style={s.doneCardText}>{active.name} · {active.address||"Oakland, CA"}</Text></View><View style={s.prepTimeline}><TimelineItem icon={<CircleCheck size={16} color={green}/>} title="Order received" done/><TimelineItem icon={<ChefHat size={16} color={maroon}/>} title="Published prep steps are saved below"/><TimelineItem icon={<Bell size={16} color={muted}/>} title="Check pickup progress in the Orders tab"/></View></View><Pressable accessibilityRole="button" onPress={()=>{setFlow('menu');closeKitchen();setTab('Orders')}} style={s.primaryBtn}><Text style={s.primaryBtnText}>View order progress</Text><ChevronRight size={19} color="#FFF"/></Pressable><Pressable accessibilityRole="button" onPress={()=>navigate('Home')} style={s.doneLink}><Text style={s.doneLinkText}>Back to browsing</Text></Pressable></View>}
      {flow==='menu'&&!menuLoading&&cartCount>0&&Object.values(cart).every(x=>x.restaurantId===active.id)&&<Pressable style={s.cartBar} accessibilityRole="button" accessibilityLabel="View bag" onPress={()=>navigate('Bag')}><View style={s.cartBubble}><Text style={s.cartBubbleText}>{cartCount}</Text></View><Text style={s.cartBarLabel}>View bag</Text><Text style={s.cartBarPrice}>{dollars(subtotal)}</Text><ChevronRight size={18} color="#FFF"/></Pressable>}
    </Enter></View>}
    {!active&&<View style={[s.bottomNav,{height:navHeight,paddingBottom:navPadding}]}>{footerTabs.map(({name,Icon})=><Pressable
      key={name} accessibilityRole="tab" accessibilityState={{selected:tab===name}}
      accessibilityLabel={name==='Bag'&&cartCount?`Bag, ${cartCount} ${cartCount===1?'item':'items'}`:name}
      onPress={()=>navigate(name)} style={[s.navItem,{flex:1,minHeight:44}]}>
      <View style={s.navIconWrap}><Icon size={21} color={tab===name?maroon:muted}/>
        {name==='Bag'&&cartCount>0&&<View style={s.navBadge}><Text style={s.navBadgeTxt}>{cartCount>99?'99+':cartCount}</Text></View>}
      </View>
      <Text style={[s.navText,tab===name&&s.navTextActive]}>{name}</Text>
    </Pressable>)}</View>}
    {showLocation&&<LocationPicker close={closeLocationPicker} locating={locating} useDevice={()=>void usePickupLocation()}
      useAddress={({label,latitude,longitude})=>{setOrigin({latitude,longitude});setLocationLabel(label);closeLocationPicker();}}
      reset={()=>{setOrigin(sanFrancisco);setLocationLabel('From San Francisco');closeLocationPicker();}}/>}
    {checkout&&showCheckoutRecovery&&flow!=='contact'&&<View style={{...StyleSheet.absoluteFillObject,justifyContent:'center',zIndex:25}}><View style={{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(28,18,14,.4)'}}/><View style={{marginHorizontal:24,backgroundColor:ivory,borderRadius:contentRadius,padding:20,borderWidth:1,borderColor:line}}><Text style={{fontSize:21,fontWeight:'500',color:ink}}>Finish secure payment</Text><Text style={{fontSize:12,color:muted,lineHeight:18,marginTop:8,marginBottom:16}}>Your bag is saved. Your order is not confirmed until payment status shows paid.</Text><Pressable accessibilityRole="button" onPress={()=>void Linking.openURL(checkout.url).catch(()=>setNotice({title:'Couldn’t open checkout',message:'Try opening secure checkout again or check your connection.'}))} style={s.primaryBtn}><Text style={s.primaryBtnText}>Open secure checkout</Text></Pressable><View style={{flexDirection:'row',justifyContent:'space-between',marginTop:14}}><Pressable accessibilityRole="button" onPress={()=>void refreshPaymentStatus(checkout)}><Text style={s.summaryEdit}>Check payment status</Text></Pressable><Pressable accessibilityRole="button" onPress={()=>void cancelPendingPayment()}><Text style={[s.summaryEdit,{color:'#A1382C'}]}>Cancel checkout</Text></Pressable></View><Pressable accessibilityRole="button" onPress={()=>setShowCheckoutRecovery(false)} style={{alignSelf:'center',paddingVertical:14}}><Text style={s.summaryEdit}>Keep browsing</Text></Pressable></View></View>}
    {notice&&<View accessibilityViewIsModal style={{...StyleSheet.absoluteFillObject,justifyContent:'center',zIndex:30}}><Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" onPress={()=>setNotice(null)} style={{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(28,18,14,.4)'}}/><View style={{marginHorizontal:28,backgroundColor:ivory,borderRadius:16,padding:21,borderWidth:1,borderColor:line}}><Text style={{fontSize:23,fontWeight:'500',color:ink}}>{notice.title}</Text><Text style={{fontSize:12,color:muted,lineHeight:18,marginTop:9,marginBottom:18}}>{notice.message}</Text><Pressable accessibilityRole="button" onPress={()=>setNotice(null)} style={s.primaryBtn}><Text style={s.primaryBtnText}>Got it</Text></Pressable></View></View>}
    {selected&&<View style={s.sheetOverlay}><Pressable style={s.scrim} onPress={()=>setSelected(null)}/><Enter key={selected.id} reduced={reduceMotion} distance={22} style={[s.sheet,{flex:0,paddingBottom:Math.max(insets.bottom+18,28)}]}><View style={s.sheetHandle}/><View style={s.sheetHead}><View><Text style={s.sheetTitle}>{selected.name}</Text><Text style={s.sheetSub}>{selected.subtitle}</Text><MealPrice meal={selected}/></View></View>
      {selected.equipment&&!equipment.some(e=>e.toLowerCase()===selected.equipment!.toLowerCase())&&<View style={s.warningBox}><Text style={s.warningTitle}>⚠  You’ll need a {selected.equipment.toLowerCase()}</Text><Text style={s.warningSub}>This meal kit needs a {selected.equipment.toLowerCase()} to finish at home. Save equipment you own in Account.</Text></View>}
      {!supabase&&<><Text style={s.optionLabel}>Make it yours</Text><View style={s.optionChips}>
        {['Extra parmesan','No parsley','Sauce on side'].map(label=>(
          <Option key={label} label={label} selected={selectedOptions.includes(label)} onPress={()=>setSelectedOptions(current=>current.includes(label)?current.filter(value=>value!==label):[...current,label])}/>
        ))}
      </View></>}
      <View style={s.qtyRow}>
        <Text style={s.optionLabel}>Quantity</Text>
        <View style={s.qtyControl}>
          <Pressable accessibilityRole="button" accessibilityLabel="Decrease quantity" hitSlop={10} onPress={()=>setSelectedQuantity(quantity=>Math.max(1,quantity-1))}><Minus size={16} color={maroon}/></Pressable>
          <Text style={s.qtyValue}>{selectedQuantity}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Increase quantity" hitSlop={10} onPress={()=>setSelectedQuantity(quantity=>Math.min(50,quantity+1))}><Plus size={16} color={maroon}/></Pressable>
        </View>
      </View>
      <Pressable accessibilityRole="button" onPress={()=>{add(selected,selectedQuantity,selectedOptions.join(' · '));setSelected(null);}} style={s.primaryBtn}>
        <Text style={s.primaryBtnText}>Add to bag · {dollars(selected.price*selectedQuantity)}</Text><Plus size={19} color="#FFF"/>
      </Pressable></Enter></View>}
  </View></View>;
}

function formatTime(iso:string,tz?:string){return new Intl.DateTimeFormat('en-US',{timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone,hour:'numeric',minute:'2-digit'}).format(new Date(iso));}
const mealImage=foodPhoto, kitchenImage=foodPhoto;
function Option({label,selected,onPress}:{label:string;selected:boolean;onPress:()=>void}) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{checked:selected}} onPress={onPress}
    style={[s.optionChip,selected&&s.optionChipOn]}>
    <Text style={[s.optionChipText,selected&&{color:maroon}]}>{selected?'✓  ':''}{label}</Text>
  </Pressable>;
}
function PickupDate({date,setDate,next,slots,timezone,address,live}:{date:number;setDate:(n:number)=>void;next:()=>void;live:boolean;slots?:Kitchen['pickupSlots'];timezone?:string;address?:string}){
  const days=live?[...new Set((slots||[]).map(x=>dayOffset(x.startsAt,timezone)))]:[1,2,3];
  return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[s.checkoutContent,{flexGrow:1}]}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepCurrent}>2  PICKUP</Text><Text style={s.stepIdle}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>When would you{ '\n' }like to pick up?</Text><Text style={s.checkoutSub}>Choose a day first. We’ll show available kitchen windows next.</Text>{days.map((n,i)=>{const count=slots?.filter(x=>dayOffset(x.startsAt,timezone)===n).length??0;return <Pressable key={n} accessibilityRole="radio" aria-checked={date===n} accessibilityState={{selected:date===n,checked:date===n}} accessibilityLabel={dateLabel(n,timezone)+', '+(count?count+' pickup windows available':i===0?'most pickup windows available':'a few windows available')} onPress={()=>setDate(n)} style={[s.dateOption,date===n&&s.dateOptionActive]}><View style={[s.radio,date===n&&s.radioActive]}>{date===n&&<View style={s.radioInner}/>}</View><View style={{flex:1}}><Text style={s.dateDay}>{dateLabel(n,timezone)}</Text><Text style={s.dateAvailability}>{slots?.length?count+' pickup windows available':n===1?'Most pickup windows available':'A few windows available'}</Text></View><Text style={s.datePill}>{live?'AVAILABLE':i===0?'POPULAR':'AVAILABLE'}</Text></Pressable>;})}<View style={{flex:1}}/>{live&&days.length===0&&<Text style={s.checkoutSub}>No pickup dates have enough stock for this bag. Return to your bag and adjust quantities.</Text>}<PickupSummary date={date} timezone={timezone} address={address}/><Pressable accessibilityRole="button" onPress={next} style={s.primaryBtn}><Text style={s.primaryBtnText}>{live&&!days.length?'Back to bag':'Choose pickup time'}</Text><ChevronRight size={19} color="#FFF"/></Pressable></ScrollView>}
function PickupTime({date,slot,setSlot,curb,setCurb,next,available,timezone,address,curbsideEnabled,editDate,live}:{date:number;slot:string;live:boolean;setSlot:(v:string)=>void;curb:boolean;setCurb:(v:boolean)=>void;next:()=>void;available?:Kitchen['pickupSlots'];timezone?:string;address?:string;curbsideEnabled:boolean;editDate:()=>void}){const times=live?[...new Set((available||[]).map(x=>formatTime(x.startsAt,timezone)))]:['4:30 PM','5:00 PM','5:30 PM','6:00 PM','6:30 PM','7:00 PM'];return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[s.checkoutContent,{flexGrow:1}]}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepCurrent}>2  PICKUP</Text><Text style={s.stepIdle}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>Pick a time that{ '\n' }works for you.</Text><Text style={s.checkoutSub}>{dateLabel(date,timezone)} · the kitchen will have your meal ready fresh.</Text><View style={s.timeGrid}>{times.map((t,i)=><Pressable key={t} accessibilityRole="radio" aria-checked={slot===t} accessibilityState={{selected:slot===t,checked:slot===t,disabled:live&&!available?.some(x=>formatTime(x.startsAt,timezone)===t)}} accessibilityLabel={t+(live&&i===0?", first available":"")} disabled={live&&!available?.some(x=>formatTime(x.startsAt,timezone)===t)} onPress={()=>setSlot(t)} style={[s.timeOption,slot===t&&s.timeOptionActive]}><Text style={[s.timeText,slot===t&&s.timeTextActive]}>{t}</Text>{live&&i===0&&<Text style={s.fewLeft}>FIRST AVAILABLE</Text>}</Pressable>)}</View>{curbsideEnabled&&<Pressable accessibilityRole="checkbox" accessibilityLabel="Curbside pickup" aria-checked={curb} accessibilityState={{checked:curb}} onPress={()=>setCurb(!curb)} style={s.curbRow}><View style={[s.checkbox,curb&&s.checkboxOn]}>{curb&&<Check size={14} color="#FFF"/>}</View><View style={{flex:1}}><View style={s.curbTitleRow}><CarFront size={18} color={maroon}/><Text style={s.curbTitle}>Curbside pickup</Text></View><Text style={s.curbSub}>We’ll bring your order to your car.</Text></View><Text style={s.curbFree}>FREE</Text></Pressable>}<View style={{flex:1}}/>{live&&!times.length&&<Text style={s.checkoutSub}>No pickup windows have enough stock for these items.</Text>}<PickupSummary date={date} slot={slot} curb={curb} timezone={timezone} address={address} onEdit={editDate}/><Pressable accessibilityRole="button" onPress={next} style={s.primaryBtn}><Text style={s.primaryBtnText}>{live&&!times.length?"Back to dates":"Continue to details"}</Text><ChevronRight size={19} color="#FFF"/></Pressable></ScrollView>}
function PickupSummary({date,slot,curb,timezone,address,onEdit}:{date:number;slot?:string;curb?:boolean;timezone?:string;address?:string;onEdit?:()=>void}){return <View style={s.pickupSummary}><MapPin size={17} color={maroon}/><View style={{flex:1}}><Text style={s.pickupSummaryTitle}>PICKUP {address?`· ${address}`:'· OAKLAND'}</Text><Text style={s.pickupSummarySub}>{dateLabel(date,timezone)}{slot?` · ${slot}`:''}{curb?' · Curbside':''}</Text></View>{onEdit&&<Pressable accessibilityRole="button" accessibilityLabel="Edit pickup date and time" onPress={onEdit} hitSlop={10}><Text style={s.summaryEdit}>EDIT</Text></Pressable>}</View>}
function TimelineItem({icon,title,done}:{icon:React.ReactNode;title:string;done?:boolean}){return <View style={s.timelineRow}><View style={s.timelineIcon}>{icon}</View><Text style={[s.timelineText,done&&{color:green}]}>{title}</Text></View>}
function LiveMenuReorder({kitchen,userId,add}:{kitchen:Kitchen;userId:string;add:(m:Meal,q:number)=>void}) {
  const restaurantId = kitchen.backendId;
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof fetchRestaurantRecentOrders>>>(null);
  useEffect(() => {
    if (!restaurantId) return;
    let current = true;
    void fetchRestaurantRecentOrders(userId,restaurantId).then(data => {
      if (current) setOrders(data);
    }).catch(() => {});
    return () => { current = false; };
  }, [restaurantId,userId]);
  const recent = orders?.filter(order => order.order_items.length) ?? [];
  if (!recent.length) return null;
  const date = new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:kitchen.timezone});

  return <View style={s.reorderBox}>
    <View style={s.reorderIcon}><CircleCheck size={19} color={green}/></View>
    <View style={{flex:1,minWidth:0}}>
      <Text accessibilityRole="header" style={s.reorderTitle}>Recent orders</Text>
      {recent.map(order => <View key={order.id} style={s.savedOrderRow}>
        <Text style={s.reorderSub}>{date.format(new Date(order.pickup_starts_at))}</Text>
        {order.order_items.map((item,index) => {
          const meal = kitchen.meals.find(candidate => candidate.backendItemId === item.item_id);
          return <View key={`${item.item_id}-${index}`} style={{marginBottom:8}}>
            <Text style={s.savedOrderName}>{item.quantity} × {item.name_snapshot}</Text>
            {meal && <Pressable accessibilityRole="button" accessibilityLabel={`Order ${meal.name} again`}
              onPress={()=>add(meal,item.quantity)} style={s.reorderBtn}>
              <Plus size={14} color="#FFF"/><Text style={s.reorderBtnText}>Order again</Text>
            </Pressable>}
          </View>;
        })}
      </View>)}
    </View>
  </View>;
}
function customerOrderStatus(order:any){if(order.payment_status==='refunded')return 'Refunded';switch(order.status){case 'placed':return 'Paid · awaiting kitchen';case 'accepted':return 'Kitchen accepted';case 'preparing':return 'Being prepared';case 'ready':return 'Ready for pickup';case 'completed':return 'Picked up';default:return 'Order updated';}}
function LiveOrders({orders}:{orders:any[]}){return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingHorizontal:22,paddingTop:20,paddingBottom:120}}><Text style={s.eyebrow}>YOUR CENA MOMENTS</Text><Text style={s.pageTitle}>Orders</Text>{orders.length===0?<View style={s.profileHero}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>No orders yet</Text><Text style={s.historyDate}>Your pickup orders and prep instructions will show here.</Text></View></View>:orders.map(order=>{const rest=Array.isArray(order.restaurants)?order.restaurants[0]:order.restaurants;const items=order.order_items||[];const date=new Intl.DateTimeFormat('en-US',{timeZone:order.restaurant_timezone||'UTC',weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(order.pickup_starts_at));return <View key={order.id} style={s.orderHistoryCard}><View style={s.historyHead}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>{rest?.name||'Cena kitchen'}</Text><Text style={s.historyDate}>{date} · {order.pickup_mode==='curbside'?'Curbside':'Pickup'}</Text></View><Text style={s.historyPrice}>{dollars((order.total_cents??order.subtotal_cents)/100)}</Text></View>{items.map((item:any)=><View key={item.item_id} style={s.historyDishes}><Text style={s.historyDish}>{item.quantity}× {item.name_snapshot}</Text>{(item.prep_steps_snapshot||[]).map((step:string,index:number)=><Text key={`${item.item_id}-${index}`} style={s.historyPrefs}>• {step}</Text>)}</View>)}{order.discount_cents>0&&<Text style={[s.historyPrefs,{color:green,marginLeft:48}]}>{order.promo_code_snapshot?order.promo_code_snapshot+' · ':''}You saved {dollars(order.discount_cents/100)}</Text>}<View style={s.orderStatus}><View style={[s.statusDot,order.payment_status==='refunded'&&{backgroundColor:'#A1382C'}]}/><Text style={[s.statusText,order.payment_status==='refunded'&&{color:'#A1382C'}]}>{customerOrderStatus(order)}</Text><Text style={s.statusCode}>{order.id.slice(0,8).toUpperCase()}</Text></View></View>})}</ScrollView>}
function Orders({onRepeat,orders,live}:{onRepeat:(k:Kitchen)=>void;orders:any[];live:boolean}){if(live)return <LiveOrders orders={orders}/>;return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingHorizontal:22,paddingTop:20,paddingBottom:120}}><Text style={s.eyebrow}>YOUR CENA MOMENTS</Text><Text style={s.pageTitle}>Orders</Text><View style={s.orderHistoryCard}><View style={s.historyHead}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>Nonna’s Table</Text><Text style={s.historyDate}>Sunday, November 15 · Pickup</Text></View><Text style={s.historyPrice}>$32.00</Text></View><View style={s.historyDishes}><Text style={s.historyDish}>2× Sunday lasagna</Text><Text style={s.historyPrefs}>Extra parmesan · No parsley</Text></View><View style={s.orderStatus}><View style={s.statusDot}/><Text style={s.statusText}>Picked up · Enjoyed</Text><Text style={s.statusCode}>CN-843921</Text></View><Pressable onPress={()=>onRepeat(demoKitchens[0])} style={s.reorderWide}><Text style={s.reorderWideText}>Order this again</Text><ChevronRight size={17} color={maroon}/></Pressable></View><View style={s.orderHistoryCard}><View style={s.historyHead}><View style={[s.historyIcon,{backgroundColor:'#F4EBDD'}]}><PackageCheck size={21} color="#98643E"/></View><View style={{flex:1}}><Text style={s.historyName}>Sol y Sazón</Text><Text style={s.historyDate}>Thursday, November 12 · Pickup</Text></View><Text style={s.historyPrice}>$13.00</Text></View><View style={s.historyDishes}><Text style={s.historyDish}>1× Mushroom tinga tacos</Text><Text style={s.historyPrefs}>Salsa on the side</Text></View><View style={s.orderStatus}><View style={s.statusDot}/><Text style={s.statusText}>Picked up · Enjoyed</Text><Text style={s.statusCode}>CN-219034</Text></View><Pressable onPress={()=>onRepeat(demoKitchens[1])} style={s.reorderWide}><Text style={s.reorderWideText}>Order this again</Text><ChevronRight size={17} color={maroon}/></Pressable></View></ScrollView>}

const s=StyleSheet.create({homeSectionTitle:{fontSize:22,lineHeight:27,fontWeight:'500',color:ink,marginBottom:12},featuredName:{fontSize:14,lineHeight:18,fontWeight:'500',color:ink,marginTop:7},featuredPrice:{fontSize:13,color:maroon,fontWeight:'500',marginTop:4},screen:{flex:1,backgroundColor:ivory},topbar:{height:58,flexDirection:'row',alignItems:'center',paddingHorizontal:22,gap:14,backgroundColor:'#FFE1D5',borderBottomWidth:1,borderBottomColor:line},brand:{flexDirection:'row',alignItems:'center',marginRight:'auto'},wordmark:{fontSize:31,fontWeight:'700',letterSpacing:-2,color:maroon},logodot:{width:6,height:6,borderRadius:4,backgroundColor:'#C57760',marginTop:17,marginLeft:2},location:{flexDirection:'row',alignItems:'center',gap:4},locText:{fontSize:14,color:ink,fontWeight:'500'},avatar:{width:34,height:34,borderRadius:17,backgroundColor:'#F0E1D9',alignItems:'center',justifyContent:'center'},avatarTxt:{fontSize:14,fontWeight:'500',color:maroon},eyebrow:{fontSize:10,fontWeight:'500',letterSpacing:1.7,color:muted,marginTop:9,marginBottom:9},heroTitle:{fontSize:36,lineHeight:39,letterSpacing:-.5,color:ink,marginBottom:17},searchbox:{height:50,borderWidth:1,borderColor:line,backgroundColor:'#FFFDFA',borderRadius:12,alignItems:'center',flexDirection:'row',paddingHorizontal:14,gap:10,marginBottom:17},searchInput:{flex:1,minWidth:0,fontSize:16,color:ink},offer:{height:176,backgroundColor:maroon,borderRadius:15,overflow:'hidden',flexDirection:'row',marginBottom:19},offerCopy:{flex:1,padding:16,justifyContent:'center'},offerPill:{alignSelf:'flex-start',flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#773128',borderRadius:20,paddingVertical:5,paddingHorizontal:8,marginBottom:8},offerPillText:{fontSize:8,fontWeight:'500',letterSpacing:1,color:'#FFF'},offerTitle:{fontSize:25,lineHeight:26,color:'#FFF',fontWeight:'500'},offerSub:{fontSize:10,color:'#F0DCD6',marginTop:6},offerDiscount:{borderWidth:1,borderColor:'#BD938A',paddingHorizontal:8,paddingVertical:4,borderRadius:5,alignSelf:'flex-start',marginTop:9},offerDiscountText:{fontSize:9,fontWeight:'500',letterSpacing:.7,color:'#FFF'},offerImage:{width:'38%',height:'100%'},categories:{flexDirection:'row',gap:8,marginBottom:21},category:{minHeight:44,borderRadius:22,borderWidth:1,borderColor:line,paddingVertical:8,paddingHorizontal:13,flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#FFFDFA'},categoryActive:{backgroundColor:maroon,borderColor:maroon},categoryText:{fontSize:13,color:ink,fontWeight:'500'},categoryTextActive:{color:'#FFF'},sectionHeader:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:12,marginTop:3},sectionTitle:{ fontWeight: '500', fontSize:21,color:ink,letterSpacing:-.4},sectionHint:{fontSize:14,color:muted,marginTop:4},seeAll:{fontSize:11,color:maroon,fontWeight:'500'},recentScroll:{gap:11,paddingRight:22,paddingBottom:23},recentCard:{width:177,borderRadius:12,backgroundColor:'#FFFDFA',borderWidth:1,borderColor:line,overflow:'hidden'},recentImage:{width:'100%',height:100,backgroundColor:'#E9CFC4'},recentBody:{padding:10},pastTag:{flexDirection:'row',alignItems:'center',gap:4},pastText:{fontSize:8,fontWeight:'500',letterSpacing:.7,color:green},recentName:{fontSize:13,fontWeight:'500',color:ink,marginTop:6},recentRestaurant:{fontSize:10,color:muted,marginTop:2},recentBottom:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:7},recentPrice:{fontSize:13,fontWeight:'500',color:maroon},quickAdd:{width:26,height:26,borderRadius:13,borderWidth:1,borderColor:'#E2D2CD',alignItems:'center',justifyContent:'center'},kitchenCard:{backgroundColor:'#FFFDFA',borderRadius:14,overflow:'hidden',borderWidth:1,borderColor:line,marginBottom:14},kitchenImage:{width:'100%',backgroundColor:'#E9CFC4'},kitchenDeal:{position:'absolute',bottom:9,left:10,backgroundColor:maroon,borderRadius:5,paddingVertical:5,paddingHorizontal:8},kitchenDealText:{color:'#FFF',fontSize:8,fontWeight:'500',letterSpacing:.8},heartBtn:{position:'absolute',right:10,top:10,width:32,height:32,borderRadius:16,backgroundColor:'rgba(30,20,15,.40)',alignItems:'center',justifyContent:'center'},kitchenBody:{flexDirection:'row',alignItems:'center',paddingHorizontal:13,paddingTop:12},kitchenName:{fontSize:18,color:ink,fontWeight:'500'},kitchenCuisine:{fontSize:11,color:muted,marginTop:3},rating:{flexDirection:'row',gap:4,alignItems:'center',backgroundColor:'#FBF4EB',paddingHorizontal:8,paddingVertical:6,borderRadius:8},ratingText:{fontSize:11,fontWeight:'500',color:ink},kitchenFoot:{flexDirection:'row',alignItems:'center',padding:13,paddingTop:10,gap:7},metaItem:{flexDirection:'row',alignItems:'center',gap:5},metaText:{fontSize:10,color:muted},dotSep:{color:'#C9BCB6'},fromPrice:{fontSize:10,fontWeight:'500',color:maroon,marginLeft:'auto'},bottomNav:{position:'absolute',bottom:0,left:0,right:0,backgroundColor:'#FFFDFA',borderTopWidth:1,borderTopColor:line,height:73,flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingTop:6},navItem:{alignItems:'center',justifyContent:'center',position:'relative'},navIconWrap:{height:25},navText:{fontSize:13,color:muted,marginTop:2},navTextActive:{color:maroon,fontWeight:'500'},navBadge:{position:'absolute',top:-3,right:-9,backgroundColor:maroon,width:15,height:15,borderRadius:8,alignItems:'center',justifyContent:'center'},navBadgeTxt:{fontSize:9,color:'#FFF',fontWeight:'500'},modalPage:{flex:1,backgroundColor:ivory},modalTop:{height:51,paddingHorizontal:21,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},backBtn:{width:32,height:32,alignItems:'flex-start',justifyContent:'center'},modalBrand:{fontWeight:'700',fontSize:23,color:maroon,letterSpacing:-1},restaurantHero:{justifyContent:'flex-end'},imageShade:{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(20,9,6,.30)'},restaurantHeroBottom:{padding:19},restaurantLabel:{color:'#F3DDD3',fontSize:8,fontWeight:'500',letterSpacing:1.4},restaurantName:{ fontWeight: '500', fontSize:34,color:'#FFF',marginTop:3},restaurantDesc:{fontSize:12,color:'#FFF',marginTop:2},restaurantMeta:{height:48,flexDirection:'row',alignItems:'center',paddingHorizontal:19,gap:19,borderBottomWidth:1,borderBottomColor:line},cutoff:{margin:15,marginBottom:18,padding:12,borderRadius:10,borderWidth:1,borderColor:'#A6C2A9',backgroundColor:'#F4F8F2',flexDirection:'row',alignItems:'center',gap:9},cutoffTitle:{fontSize:9,fontWeight:'500',letterSpacing:.7,color:green},cutoffSub:{fontSize:10,color:'#617464',marginTop:3},countdown:{fontSize:11,color:green,fontWeight:'500',fontVariant:['tabular-nums']},menuTitleRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:18,marginBottom:11},dealBadge:{fontSize:8,color:green,fontWeight:'500',borderWidth:1,borderColor:'#B8CCB8',borderRadius:5,paddingHorizontal:7,paddingVertical:5},reorderBox:{marginHorizontal:15,marginBottom:10,padding:12,backgroundColor:'#F1F6EF',borderWidth:1,borderColor:'#D7E5D6',borderRadius:11,flexDirection:'row',gap:9},reorderIcon:{width:29,height:29,borderRadius:15,backgroundColor:'#FFFDFA',alignItems:'center',justifyContent:'center'},reorderTitle:{fontSize:17,fontWeight:'500',color:green},reorderSub:{fontSize:12,color:'#617464',marginTop:3,marginBottom:9},savedOrderRow:{borderTopWidth:1,borderTopColor:'#D9E7D7',paddingTop:8,marginTop:2,marginBottom:1},savedOrderName:{fontSize:14,fontWeight:'500',color:ink},savedOrderOpts:{fontSize:9,color:muted,marginTop:2},reorderBtn:{minHeight:44,alignSelf:'flex-start',marginTop:7,backgroundColor:green,borderRadius:7,flexDirection:'row',alignItems:'center',paddingHorizontal:9,gap:5},reorderBtnText:{fontSize:13,color:'#FFF',fontWeight:'500'},mealRow:{minHeight:130,paddingVertical:14,paddingHorizontal:18,borderBottomWidth:1,borderColor:line,flexDirection:'row',alignItems:'center',gap:12},mealText:{flex:1},mealTags:{flexDirection:'row',gap:5,marginBottom:4},mealTag:{fontSize:8,color:'#9B6233',fontWeight:'500',letterSpacing:.7},equipmentTag:{fontSize:8,color:'#A1382C',fontWeight:'500',letterSpacing:.6,backgroundColor:'#FCEBE8',paddingHorizontal:5,paddingVertical:3,borderRadius:3},mealName:{fontSize:15,fontWeight:'500',color:ink},mealDesc:{fontSize:14,color:muted,marginTop:4,lineHeight:19},prices:{flexDirection:'row',alignItems:'center',gap:7,marginTop:7},mealPrice:{fontSize:12,color:maroon,fontWeight:'500'},oldPrice:{fontSize:10,color:'#9B908A',textDecorationLine:'line-through'},inCart:{fontSize:9,color:green,fontWeight:'500',marginTop:5},mealImage:{width:92,height:92,borderRadius:9,backgroundColor:'#E9CFC4'},addBubble:{position:'absolute',right:-5,bottom:-5,width:30,height:30,borderRadius:15,backgroundColor:'#FFFDFA',borderWidth:1,borderColor:line,alignItems:'center',justifyContent:'center',elevation:2},cartBar:{position:'absolute',bottom:12,left:16,right:16,height:53,borderRadius:12,backgroundColor:maroon,flexDirection:'row',alignItems:'center',paddingHorizontal:14,gap:10,elevation:4},cartBubble:{width:23,height:23,borderRadius:12,backgroundColor:'#FFFDFA',alignItems:'center',justifyContent:'center'},cartBubbleText:{fontSize:11,fontWeight:'500',color:maroon},cartBarLabel:{fontSize:13,color:'#FFF',fontWeight:'500',flex:1},cartBarPrice:{fontSize:13,color:'#FFF',fontWeight:'500'},checkoutContent:{flex:1,paddingHorizontal:23,paddingTop:12,paddingBottom:13},steps:{flexDirection:'row',gap:13,marginBottom:25},stepDone:{fontSize:9,color:green,fontWeight:'500',letterSpacing:.7},stepCurrent:{fontSize:9,color:maroon,fontWeight:'500',letterSpacing:.7},stepIdle:{fontSize:9,color:'#B4A9A4',fontWeight:'500',letterSpacing:.7},checkoutTitle:{ fontWeight: '500', fontSize:30,lineHeight:34,color:ink,letterSpacing:-.6},checkoutSub:{fontSize:15,color:muted,lineHeight:21,marginTop:8,marginBottom:23},dateOption:{minHeight:69,borderWidth:1,borderColor:line,borderRadius:11,backgroundColor:'#FFFDFA',marginBottom:9,paddingHorizontal:13,flexDirection:'row',alignItems:'center',gap:11},dateOptionActive:{borderColor:maroon,backgroundColor:'#FFF0E8'},radio:{width:19,height:19,borderRadius:10,borderWidth:1.5,borderColor:'#CBBDB6',alignItems:'center',justifyContent:'center'},radioActive:{borderColor:maroon},radioInner:{width:9,height:9,borderRadius:5,backgroundColor:maroon},dateDay:{fontSize:13,fontWeight:'500',color:ink},dateAvailability:{fontSize:13,color:muted,marginTop:4},datePill:{fontSize:8,color:green,fontWeight:'500',letterSpacing:.5},pickupSummary:{height:56,borderTopWidth:1,borderTopColor:line,flexDirection:'row',alignItems:'center',gap:10,marginBottom:9},pickupSummaryTitle:{fontSize:9,fontWeight:'500',letterSpacing:.7,color:ink},pickupSummarySub:{fontSize:10,color:muted,marginTop:3},summaryEdit:{fontSize:9,color:maroon,fontWeight:'500',letterSpacing:.5},primaryBtn:{height:52,backgroundColor:maroon,borderRadius:11,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8},primaryBtnText:{fontSize:13,color:'#FFF',fontWeight:'500'},timeGrid:{flexDirection:'row',flexWrap:'wrap',gap:9,marginBottom:22},timeOption:{height:51,width:'31.5%',borderRadius:9,borderWidth:1,borderColor:line,backgroundColor:'#FFFDFA',alignItems:'center',justifyContent:'center'},timeOptionActive:{borderColor:maroon,backgroundColor:'#FFF0E8'},timeText:{fontSize:11,color:ink,fontWeight:'500'},timeTextActive:{color:maroon,fontWeight:'500'},fewLeft:{fontSize:7,color:'#9D6843',fontWeight:'500',marginTop:3},curbRow:{minHeight:74,borderWidth:1,borderColor:line,borderRadius:10,backgroundColor:'#FFFDFA',padding:12,flexDirection:'row',alignItems:'center',gap:10},checkbox:{width:20,height:20,borderWidth:1,borderColor:'#C6BAB4',borderRadius:5,alignItems:'center',justifyContent:'center'},checkboxOn:{backgroundColor:maroon,borderColor:maroon},curbTitleRow:{flexDirection:'row',alignItems:'center',gap:6},curbTitle:{fontSize:12,fontWeight:'500',color:ink},curbSub:{fontSize:10,color:muted,marginTop:4},curbFree:{fontSize:9,color:green,fontWeight:'500'},totalRow:{height:42,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},totalLabel:{fontSize:11,color:muted},totalPrice:{fontSize:16,fontWeight:'500',color:ink},finePrint:{fontSize:12,color:muted,textAlign:'center',marginTop:9},inputWrap:{height:51,borderWidth:1,borderColor:line,backgroundColor:'#FFFDFA',borderRadius:10,marginBottom:10,paddingHorizontal:14,flexDirection:'row',alignItems:'center',gap:10},contactInput:{fontSize:13,color:ink,flex:1},checkoutInfo:{flexDirection:'row',gap:9,backgroundColor:'#F0F6EF',padding:12,borderRadius:9,marginTop:5,alignItems:'center'},checkoutInfoText:{fontSize:13,lineHeight:18,color:'#526557',flex:1},doneView:{flex:1,paddingHorizontal:24,paddingTop:30,paddingBottom:19,alignItems:'center'},doneIcon:{width:58,height:58,borderRadius:29,backgroundColor:green,alignItems:'center',justifyContent:'center',marginBottom:19},doneEyebrow:{fontSize:9,fontWeight:'500',letterSpacing:1.4,color:green},doneTitle:{ fontWeight: '500', fontSize:42,lineHeight:44,color:ink,textAlign:'center',marginTop:8},doneSub:{fontSize:12,lineHeight:18,color:muted,textAlign:'center',marginTop:11,maxWidth:290},doneCard:{width:'100%',borderWidth:1,borderColor:line,borderRadius:12,backgroundColor:'#FFFDFA',padding:15,marginTop:22,marginBottom:20},doneCardRow:{flexDirection:'row',alignItems:'center',gap:9,marginVertical:5},doneCardText:{fontSize:11,fontWeight:'500',color:ink},prepTimeline:{borderTopWidth:1,borderColor:line,marginTop:10,paddingTop:10},timelineRow:{flexDirection:'row',alignItems:'center',gap:9,minHeight:33},timelineIcon:{width:20,alignItems:'center'},timelineText:{fontSize:10,color:muted},doneLink:{padding:12},doneLinkText:{fontSize:11,color:maroon,fontWeight:'500'},sheetOverlay:{...StyleSheet.absoluteFillObject,justifyContent:'flex-end'},scrim:{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(28,18,14,.38)'},sheet:{backgroundColor:ivory,borderTopLeftRadius:20,borderTopRightRadius:20,paddingHorizontal:21,paddingTop:9},sheetHandle:{width:38,height:4,borderRadius:3,backgroundColor:'#D8CCC6',alignSelf:'center',marginBottom:16},sheetHead:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18},sheetTitle:{ fontWeight: '500', fontSize:23,color:ink},sheetSub:{fontSize:10,color:muted,marginTop:4,maxWidth:255},sheetPrice:{fontSize:16,fontWeight:'500',color:maroon},warningBox:{borderWidth:1,borderColor:'#E5AAA1',backgroundColor:'#FFF0ED',padding:11,borderRadius:8,marginBottom:15},warningTitle:{fontSize:11,fontWeight:'500',color:'#A23B30'},warningSub:{fontSize:9,lineHeight:14,color:'#87544D',marginTop:4},optionLabel:{fontSize:9,color:muted,fontWeight:'500',letterSpacing:1},optionChips:{flexDirection:'row',gap:6,marginTop:9,marginBottom:19},optionChip:{paddingHorizontal:9,paddingVertical:8,borderWidth:1,borderColor:line,borderRadius:20,backgroundColor:'#FFFDFA'},optionChipOn:{borderColor:'#B77A6E',backgroundColor:'#F7EDE7'},optionChipText:{fontSize:9,color:ink},qtyRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:18},qtyControl:{height:35,width:104,borderWidth:1,borderColor:line,borderRadius:8,backgroundColor:'#FFFDFA',flexDirection:'row',alignItems:'center',justifyContent:'space-around'},qtyValue:{fontSize:13,fontWeight:'500',color:ink},pageTitle:{ fontWeight: '500', fontSize:35,color:ink,letterSpacing:-.8,marginBottom:20},orderHistoryCard:{borderWidth:1,borderColor:line,borderRadius:13,backgroundColor:'#FFFDFA',padding:14,marginBottom:13},historyHead:{flexDirection:'row',alignItems:'center',gap:10},historyIcon:{width:38,height:38,borderRadius:10,backgroundColor:'#EFF5ED',alignItems:'center',justifyContent:'center'},historyName:{fontSize:14,fontWeight:'500',color:ink},historyDate:{fontSize:13,color:muted,marginTop:3},historyPrice:{fontSize:12,fontWeight:'500',color:ink},historyDishes:{marginLeft:48,marginTop:12},historyDish:{fontSize:11,color:ink,fontWeight:'500'},historyPrefs:{fontSize:13,color:muted,marginTop:4},orderStatus:{borderTopWidth:1,borderColor:line,marginTop:12,paddingTop:11,flexDirection:'row',alignItems:'center',gap:6},statusDot:{width:7,height:7,borderRadius:4,backgroundColor:green},statusText:{fontSize:10,color:green,fontWeight:'500'},statusCode:{fontSize:9,color:muted,marginLeft:'auto'},reorderWide:{height:37,borderWidth:1,borderColor:'#E2D1CB',borderRadius:8,marginTop:11,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:5},reorderWideText:{fontSize:11,color:maroon,fontWeight:'500'},profileHero:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:'#FFFDFA',borderRadius:12,borderWidth:1,borderColor:line,marginBottom:21},profileAvatar:{width:46,height:46,borderRadius:23,backgroundColor:'#F0E1D9',alignItems:'center',justifyContent:'center'},profileInitial:{fontSize:19,color:maroon,fontWeight:'500'},profileName:{fontSize:17,color:ink,fontWeight:'500'},profileHint:{fontSize:10,color:muted,marginTop:3},settingsSection:{fontSize:9,fontWeight:'500',letterSpacing:1.1,color:muted,marginTop:12,marginBottom:7},settingRow:{minHeight:61,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:1,borderBottomColor:line},settingIcon:{width:34,height:34,borderRadius:9,backgroundColor:'#F0E1D9',alignItems:'center',justifyContent:'center'},settingTitle:{fontSize:12,fontWeight:'500',color:ink},settingDesc:{fontSize:10,color:muted,marginTop:3},accountFooter:{fontStyle:'italic',textAlign:'center',color:'#9A8981',fontSize:13,marginTop:32}});
