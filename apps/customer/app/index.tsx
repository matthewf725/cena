import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Image, ImageBackground, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import * as Location from 'expo-location';
import { ChevronRight, Search, ShoppingBag, MapPin, Star, Plus, Minus, ArrowLeft, CircleCheck, CalendarDays, Phone, Mail, Check, CarFront, PackageCheck, ChefHat, Soup, Bell, CreditCard, UserRound } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Enter, useReducedMotion } from '../components/motion';
import { DiscoveryFeed } from '../components/discovery-feed';
import { Account } from '../components/account';
import { Bag, type BagLine } from '../components/bag';
import { LocationPicker } from '../components/location-picker';
import { MealPrice } from '../components/meal-price';
import { PickupCountdown } from '../components/pickup-countdown';
import { Kitchen, Meal, kitchens as demoKitchens } from '../lib/data';
import { formatDistance, sanFrancisco, type PickupOrigin } from '../lib/discovery';
import { foodPhoto } from '../lib/food-photos';
import { fetchKitchenBySlug, fetchOrderHistory, loadKitchenMenu, placeOrder, saveOrder, sendEmailCode, supabase, trackEvent, verifyEmailCode } from '../lib/supabase';

const footerTabs = [{ name: 'Home', Icon: Search }, { name: 'Orders', Icon: PackageCheck }, { name: 'Bag', Icon: ShoppingBag }] as const;
type Tab = typeof footerTabs[number]['name'] | 'Account';
const maroon='#5D100A', ivory='#FAF6F3', ink='#231F1C', muted='#605751', line='#EDE5E0', green='#245C40';
const dollars=(n:number)=>`$${n.toFixed(2)}`;
const recentlyOrdered: Record<string,{qty:number; options:string}> = { lasagna:{qty:2,options:'Extra parmesan · No parsley'}, tacos:{qty:1,options:'Salsa on the side'} };

export default function Home() {
  const insets=useSafeAreaInsets();
  const {width}=useWindowDimensions();
  const reduceMotion=useReducedMotion();
  const contentRadius=16+Math.max(0,Math.min(10,(390-width)*.08));
  const [tab,setTab]=useState<Tab>('Home'), [active,setActive]=useState<Kitchen|null>(null), [backendOrders,setBackendOrders]=useState<any[]>([]), [completedItems,setCompletedItems]=useState<{meal:Meal;qty:number}[]>([]), [query,setQuery]=useState(''), [cart,setCart]=useState<Record<string,{meal:Meal;qty:number;options:string;restaurantId:string}>>({}), [selected,setSelected]=useState<Meal|null>(null), [selectedQuantity,setSelectedQuantity]=useState(1), [selectedOptions,setSelectedOptions]=useState<string[]>([]), [flow,setFlow]=useState<'menu'|'date'|'time'|'contact'|'done'>('menu'), [date,setDate]=useState(1), [slot,setSlot]=useState('5:30 PM'), [curb,setCurb]=useState(false), [email,setEmail]=useState(''), [phone,setPhone]=useState(''), [displayName,setDisplayName]=useState(''), [vehicleMake,setVehicleMake]=useState(''), [vehicleModel,setVehicleModel]=useState(''), [vehicleColor,setVehicleColor]=useState(''), [equipment,setEquipment]=useState<string[]>([]), [analyticsConsented,setAnalyticsConsented]=useState(false), [termsAccepted,setTermsAccepted]=useState(false), [hydrated,setHydrated]=useState(false), [otpSent,setOtpSent]=useState(false), [otpCode,setOtpCode]=useState(''), [now,setNow]=useState(Date.now()), [notice,setNotice]=useState<{title:string;message:string}|null>(null);
  const [checkingBag,setCheckingBag]=useState(false);
  const [origin,setOrigin]=useState<PickupOrigin>(sanFrancisco);
  const [locationLabel,setLocationLabel]=useState('From San Francisco');
  const [showLocation,setShowLocation]=useState(false);
  const [locating,setLocating]=useState(false);
  const [menuLoading,setMenuLoading]=useState(false);
  const [demoRecentIds,setDemoRecentIds]=useState<string[]>([]);
  const [demoRecentMeals,setDemoRecentMeals]=useState<string[]>([]);
  const [authenticated,setAuthenticated]=useState(false);
  const emailEdited=useRef(false);
  const storageHydrated=useRef(false);
  const sessionEmail=useRef<string|null>(null);
  const updateEmail=(value:string)=>{emailEdited.current=true;setEmail(value);};
  const menuRequest=useRef(0);
  const bagRequest=useRef(0);
  const idempotency=useRef({ fingerprint:'', key:'' });
  const submitting=useRef(false);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!supabase)return;
    let request=0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      clearTimeout(pending);
      const current=++request;
      setAuthenticated(Boolean(session));
      sessionEmail.current=session?.user.email??null;
      if(event==='SIGNED_OUT'){emailEdited.current=false;setEmail('');}
      else if(session?.user.email&&(event==='SIGNED_IN'||(storageHydrated.current&&!emailEdited.current))){emailEdited.current=false;setEmail(session.user.email);}
      if(session){
        pending=setTimeout(()=>void fetchOrderHistory().then(history=>{
          if(current===request)setBackendOrders(history.data??[]);
        }).catch(()=>{}),0);
      }else setBackendOrders([]);
    });
    return ()=>{request++;clearTimeout(pending);subscription.unsubscribe();};
  },[]);
  useEffect(()=>{AsyncStorage.getItem('cena.customer.demo.v1').then(raw=>{if(raw){const v=JSON.parse(raw);setCart(v.cart||{});setEquipment(v.equipment||[]);if(!emailEdited.current)setEmail(sessionEmail.current||v.email||'');setPhone(v.phone||'');setDisplayName(v.displayName||'');setDemoRecentIds(v.demoRecentIds||[]);setDemoRecentMeals(v.demoRecentMeals||[]);setAnalyticsConsented(!!v.analyticsConsented);setTermsAccepted(!!v.termsAccepted);}}).catch(()=>{}).finally(()=>{storageHydrated.current=true;if(sessionEmail.current&&!emailEdited.current)setEmail(sessionEmail.current);setHydrated(true);});},[]);
  useEffect(()=>{if(hydrated)AsyncStorage.setItem('cena.customer.demo.v1',JSON.stringify({cart,equipment,email,phone,displayName,demoRecentIds,demoRecentMeals,analyticsConsented,termsAccepted})).catch(()=>{});},[cart,equipment,email,phone,displayName,demoRecentIds,demoRecentMeals,analyticsConsented,termsAccepted,hydrated]);
  useEffect(()=>{if(supabase&&analyticsConsented&&query.trim()){const timer=setTimeout(()=>void trackEvent('search',undefined,{query_length:query.trim().length}),700);return ()=>clearTimeout(timer);}},[query,analyticsConsented]);
  const cartCount=Object.values(cart).reduce((n,x)=>n+x.qty,0), subtotal=Object.values(cart).reduce((n,x)=>n+x.qty*x.meal.price,0);
  const eligibleSlots=active?.pickupSlots?.filter(x=>Date.parse(x.cutoffAt)>now&&Object.values(cart).every(item=>!!item.meal.backendItemId&&(x.remaining[item.meal.backendItemId]||0)>=item.qty));
  const selectedPickup=eligibleSlots?.find(x=>dayOffset(x.startsAt,active?.timezone)===date&&formatTime(x.startsAt,active?.timezone)===slot);
  const recentIds=useMemo(() => supabase
    ? [...new Set<string>(backendOrders.filter(order=>order.status!=='cancelled').map(order=>order.restaurant_id))].slice(0,20)
    : demoRecentIds, [backendOrders,demoRecentIds]);
  const recentMealIds=useMemo(()=>supabase
    ? [...new Set<string>(backendOrders.filter(order=>order.status!=='cancelled').flatMap(order=>order.order_items?.map((item:{item_id:string|null})=>item.item_id).filter(Boolean)??[]))].slice(0,20)
    : demoRecentMeals, [backendOrders,demoRecentMeals]);
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
    if(!active)return;
    const restaurantId=active.id;
    const current=Object.values(cart)[0]?.restaurantId;
    if(current&&current!==restaurantId){setNotice({title:'One kitchen at a time',message:'Finish this bag before starting an order from another kitchen.'});return;}
    if(!cart[meal.id]&&Object.keys(cart).length>=30){setNotice({title:'Your bag is full',message:'A pickup order can include up to 30 different meal kits.'});return;}
    setCart(c=>({...c,[meal.id]:{meal,qty:Math.min(50,(c[meal.id]?.qty||0)+qty),options:options||c[meal.id]?.options||'',restaurantId}}));
  };
  const changeQty=(id:string,d:number)=>{
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
  const openKitchen=async (kitchen:Kitchen, mealId?:string)=>{
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
      const first=loaded.pickupSlots?.find(slot=>Date.parse(slot.cutoffAt)>Date.now());
      if(first){
        setDate(dayOffset(first.startsAt,loaded.timezone));
        setSlot(formatTime(first.startsAt,loaded.timezone));
      }else if(!loaded.backendId){
        setDate(1);
        setSlot('5:30 PM');
      }
      const meal=loaded.meals.find(item=>item.id===mealId);
      if(meal){
        setSelectedQuantity(1);
        setSelectedOptions([]);
        setSelected(meal);
      }else if(mealId){
        setNotice({title:'Meal kit unavailable',message:'Pick another meal kit from this kitchen.'});
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
    if(checkingBag||!lines.length)return;
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
      const first=loaded.pickupSlots?.find(window=>Date.parse(window.cutoffAt)>Date.now()&&lines.every(item=>(window.remaining[item.meal.id]??0)>=item.qty));
      if(loaded.backendId&&!first){
        setNotice({title:'No pickup time fits this bag',message:'Try a smaller quantity or remove a kit to see available pickup times.'});
        return;
      }
      setCart(current=>Object.fromEntries(Object.entries(current).map(([id,item])=>[id,{...item,meal:meals.get(id)??item.meal}])));
      setDate(first?dayOffset(first.startsAt,loaded.timezone):1);
      setSlot(first?formatTime(first.startsAt,loaded.timezone):'5:30 PM');
      setCurb(false);
      setActive(loaded);
      setFlow('date');
    }catch{
      if(request===bagRequest.current)setNotice({title:'Pickup availability couldn’t load',message:'Check your connection and try again.'});
    }finally{
      if(request===bagRequest.current)setCheckingBag(false);
    }
  }
  const openMeal=(m:Meal)=>{setSelectedQuantity(1);setSelectedOptions([]);setSelected(m);if(supabase&&analyticsConsented&&active?.backendId)void trackEvent('item_view',active.backendId,m.backendItemId?{item_id:m.backendItemId}:{});};
  const openPolicy=async(path:'consumer-terms'|'privacy-policy')=>{const base=process.env.EXPO_PUBLIC_CENA_SITE_URL;if(base){try{await Linking.openURL(`${base.replace(/\/$/,'')}/${path==='consumer-terms'?'terms.html':'privacy.html'}`);return;}catch{}}setNotice({title:path==='consumer-terms'?'Consumer terms':'Privacy policy',message:path==='consumer-terms'?'Orders reserve restaurant-prepared items for pickup. Cena does not take payment in the app. Restaurants are responsible for menu and allergen details.':`We use your email and optional phone to link and manage pickup orders. Anonymous browsing analytics are optional and off until you choose to share them.`});};
  const closeFlow=()=>{if(flow==='time')setFlow('date');else if(flow==='contact')setFlow('time');else closeKitchen();};
  const place=async()=>{
    if(submitting.current)return;
    submitting.current=true;
    try{
    let sessionAlreadySignedIn=authenticated;
    if(supabase){const currentSession=await supabase.auth.getSession();const signedInEmail=currentSession.data.session?.user.email;if(signedInEmail){sessionAlreadySignedIn=true;sessionEmail.current=signedInEmail;emailEdited.current=false;setEmail(signedInEmail);setAuthenticated(true);}}
    const cartKitchen=Object.values(cart)[0]?.restaurantId;
    if(cartKitchen&&active&&cartKitchen!==active.id){setNotice({title:'Your bag belongs to another kitchen',message:'Return to that kitchen to finish this pickup order.'});return;}
    if(supabase){
      if(!sessionAlreadySignedIn){
        if(!otpSent){const sent=await sendEmailCode(email);if(sent.error){setNotice({title:'Couldn’t send your code',message:sent.error.message});return;}setOtpSent(true);setNotice({title:'Check your email',message:'We sent a one-time sign-in code. Enter it below to finish.'});return;}
        const verified=await verifyEmailCode(email,otpCode);if(verified.error){setNotice({title:'That code didn’t work',message:verified.error.message});return;}
      }
      const selectedSlot=selectedPickup;
      if(!active?.backendId||!selectedSlot||Object.values(cart).some(x=>!x.meal.backendItemId)||Object.values(cart).some(x=>selectedSlot.remaining[x.meal.backendItemId!]<(x.qty||0))){setNotice({title:'Pickup availability changed',message:'One or more meal kits are no longer available for that window. Choose another time or update your bag.'});return;}
      if(curb&&(!vehicleMake.trim()||!vehicleModel.trim()||!vehicleColor.trim())){setNotice({title:'Add your vehicle details',message:'Curbside pickup needs your vehicle make, model, and color.'});return;}
      const orderInput={restaurantId:active.backendId,slotId:selectedSlot.id,pickupMode:curb?'curbside' as const:'counter' as const,vehicle:curb?{make:vehicleMake,model:vehicleModel,color:vehicleColor}:undefined,items:Object.values(cart).map(x=>({item_id:x.meal.backendItemId!,quantity:x.qty}))};
      const fingerprint=JSON.stringify(orderInput);
      if(idempotency.current.fingerprint!==fingerprint)idempotency.current={fingerprint,key:`cena-${Date.now()}-${Math.random().toString(36).slice(2,8)}`};
      const placed=await placeOrder({...orderInput,idempotencyKey:idempotency.current.key});
      if(placed.error){setNotice({title:'Couldn’t place your order',message:placed.error.message});return;}const history=await fetchOrderHistory();if(history.data)setBackendOrders(history.data as any[]);
    }else{
      if(active)setDemoRecentIds(ids=>[active.id,...ids.filter(id=>id!==active.id)].slice(0,20));
      setDemoRecentMeals(ids=>[...new Set([...Object.keys(cart),...ids])].slice(0,20));
      const result=await saveOrder({items:Object.values(cart).map(x=>({name:x.meal.name,qty:x.qty,options:x.options})),pickup_date:dateLabel(date,active?.timezone),pickup_time:slot,curbside:curb,email,phone,total:subtotal});if(result.error){setNotice({title:'Couldn’t place order',message:'Please try again.'});return;}
    }
    setCompletedItems(Object.values(cart).map(x=>({meal:x.meal,qty:x.qty})));idempotency.current={fingerprint:'',key:''};setFlow('done');setCart({});
    }catch{
      setNotice({title:'Couldn’t finish checkout',message:'Check your connection and try again.'});
    }finally{
      submitting.current=false;
    }
  };
  return <View style={[s.screen,{paddingTop:insets.top}]}><View style={{flex:1,width:'100%',maxWidth:560,alignSelf:'center'}}>
    <View style={{flex:1}} pointerEvents={active?'none':'auto'} aria-hidden={Boolean(active)}
      accessibilityElementsHidden={Boolean(active)} importantForAccessibility={active?'no-hide-descendants':'auto'}>
      <View style={[s.topbar,{paddingHorizontal:width<390?14:22,gap:width<390?8:14}]}><View style={s.brand}><Text style={s.wordmark}>cena</Text><View style={s.logodot}/></View><Pressable accessibilityRole="button" accessibilityLabel={`Change pickup area, ${locationLabel}`}
        onPress={()=>setShowLocation(true)} style={[s.location,{flexShrink:1,minWidth:0}]}>
          <MapPin size={15} color={maroon}/><Text numberOfLines={1} style={[s.locText,{flexShrink:1}]}>{locating?'Finding location…':locationLabel}</Text>
        </Pressable><Pressable accessibilityRole="button" accessibilityLabel="Open account" onPress={()=>navigate('Account')} style={[s.avatar,{flexShrink:0}]}><UserRound size={17} color={maroon}/></Pressable></View>
      <Enter key={tab} reduced={reduceMotion}>
        {tab==='Home'?<DiscoveryFeed width={Math.min(width,560)} radius={contentRadius}
          query={query} setQuery={setQuery} reduced={reduceMotion} origin={origin} fromCity={fromCity} recentIds={recentIds} recentMealIds={recentMealIds}
          open={kitchen=>void openKitchen(kitchen)} openMeal={({kitchen,meal})=>void openKitchen(kitchen,meal.id)}/>:tab==='Orders'?<Orders onRepeat={(k)=>openKitchen(k)} orders={backendOrders} live={!!supabase}/>:tab==='Bag'?<Bag items={Object.values(cart)} subtotal={subtotal} radius={contentRadius} loading={checkingBag} bottomNavHeight={73} change={changeQty} remove={id=>changeQty(id,-Infinity)} browse={()=>navigate('Home')} checkout={()=>void continueBag()}/>:<Account
          equipment={equipment} setEquipment={setEquipment} analyticsConsented={analyticsConsented}
          setAnalyticsConsented={setAnalyticsConsented} email={email} setEmail={updateEmail} phone={phone} setPhone={setPhone}
          displayName={displayName} setDisplayName={setDisplayName}/>}
      </Enter>
    </View>

    {active&&<Enter key={active.id} reduced={reduceMotion} style={[s.modalPage,StyleSheet.absoluteFillObject,{zIndex:3}]}><View style={s.modalTop}><Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={closeFlow} style={s.backBtn}><ArrowLeft size={20} color={ink}/></Pressable><Text style={s.modalBrand}>cena</Text><Pressable accessibilityRole="button" accessibilityLabel="Open bag" onPress={()=>navigate('Bag')}><ShoppingBag size={21} color={maroon}/></Pressable></View>
      {flow==='menu'&&<ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingBottom:120}}>
        <ImageBackground source={kitchenImage(active.image.startsWith("http")?active.id:active.image)} resizeMode="cover" style={[s.restaurantHero,{height:Math.round(Math.min(width,560)*9/16)}]}><View style={s.imageShade}/><View style={s.restaurantHeroBottom}><Text style={s.restaurantLabel}>YOUR NEIGHBORHOOD KITCHEN</Text><Text style={s.restaurantName}>{active.name}</Text><Text style={s.restaurantDesc}>{active.cuisine}</Text></View></ImageBackground>
        <View style={s.restaurantMeta}>{active.rating&&<View style={s.metaItem}><Star size={15} color="#B97832" fill="#B97832"/><Text style={s.metaText}>{active.rating} rating</Text></View>}{formatDistance(active.distanceMiles,fromCity)&&<View style={s.metaItem}><MapPin size={15} color={muted}/><Text style={s.metaText}>{formatDistance(active.distanceMiles,fromCity)}</Text></View>}{active.address&&<View style={s.metaItem}><MapPin size={15} color={muted}/><Text style={s.metaText}>{active.address}</Text></View>}</View>
        <View style={{marginHorizontal:18,marginBottom:16}}><PickupCountdown slots={eligibleSlots} timezone={active.timezone}/></View>
        <View style={s.menuTitleRow}><View><Text style={s.sectionTitle}>Finish-at-home favorites</Text><Text style={s.sectionHint}>Everything you need, already prepped.</Text></View><Text style={s.dealBadge}>~25% OFF</Text></View>
        {menuLoading&&<ActivityIndicator color={maroon} accessibilityLabel="Loading menu"/>}
        {!menuLoading&&!active.meals.length&&<Text style={[s.sectionHint,{marginHorizontal:18}]}>No meal kits are available for pickup at this kitchen right now.</Text>}
        {supabase?<LiveMenuReorder kitchen={active} orders={backendOrders} add={(m,q)=>add(m,q)}/>:Object.values(recentlyOrdered).some(x=>active.meals.some(m=>m.id in recentlyOrdered))&&<View style={s.reorderBox}><View style={s.reorderIcon}><CircleCheck size={19} color={green}/></View><View style={{flex:1}}><Text style={s.reorderTitle}>Your usual, just how you like it</Text><Text style={s.reorderSub}>Previous quantity and preferences are saved.</Text>{active.meals.filter(m=>m.id in recentlyOrdered).map(m=><View key={m.id} style={s.savedOrderRow}><Text style={s.savedOrderName}>{m.name}</Text><Text style={s.savedOrderOpts}>{recentlyOrdered[m.id].qty}× · {recentlyOrdered[m.id].options}</Text><Pressable onPress={()=>add(m,recentlyOrdered[m.id].qty,recentlyOrdered[m.id].options)} style={s.reorderBtn}><Plus size={14} color="#FFF"/><Text style={s.reorderBtnText}>Add usual</Text></Pressable></View>)}</View></View>}
        {active.meals.map(m=><Pressable onPress={()=>openMeal(m)} style={s.mealRow} key={m.id}><View style={s.mealText}><View style={s.mealTags}>{m.tag&&<Text style={s.mealTag}>{m.tag}</Text>}{m.equipment&&!equipment.some(e=>e.toLowerCase()===m.equipment!.toLowerCase())&&<Text style={s.equipmentTag}>NEEDS {m.equipment.toUpperCase()}</Text>}</View><Text style={s.mealName}>{m.name}</Text><Text style={s.mealDesc}>{m.subtitle}</Text><MealPrice meal={m}/>{cart[m.id]&&<Text style={s.inCart}>In your bag · {cart[m.id].qty}</Text>}</View><View><Image source={mealImage(m.image.startsWith("http")?m.id:m.image)} resizeMode="cover" style={s.mealImage}/><Pressable accessibilityRole="button" accessibilityLabel={`Add ${m.name} to bag`} onPress={event=>{event.stopPropagation();add(m);}} style={s.addBubble}><Plus size={19} color={maroon}/></Pressable></View></Pressable>)}
      </ScrollView>}
      {flow==='date'&&<PickupDate date={date} live={!!active.backendId} slots={eligibleSlots} timezone={active.timezone} address={active.address} setDate={n=>{setDate(n);const first=eligibleSlots?.find(x=>dayOffset(x.startsAt,active.timezone)===n);if(first)setSlot(formatTime(first.startsAt,active.timezone));}} next={()=>{if(active.backendId&&!eligibleSlots?.length)closeKitchen();else setFlow('time');}}/>}
      {flow==='time'&&<PickupTime date={date} live={!!active.backendId} available={eligibleSlots?.filter(x=>dayOffset(x.startsAt,active.timezone)===date)} timezone={active.timezone} address={active.address} slot={slot} setSlot={setSlot} curb={curb} setCurb={setCurb} curbsideEnabled={active.curbsideEnabled!==false} next={()=>setFlow(active.backendId&&!eligibleSlots?.some(x=>dayOffset(x.startsAt,active.timezone)===date)?'date':'contact')}/>}
      {flow==='contact'&&<KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS==='ios'?'padding':'height'}><ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={[s.checkoutContent,{flexGrow:1}]}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepDone}>2  PICKUP</Text><Text style={s.stepCurrent}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>Add your email for{ '\n' }your pickup order.</Text><Text style={s.checkoutSub}>Your email links this order to your pickup history.</Text><View style={s.inputWrap}><Mail size={18} color={muted}/><TextInput style={s.contactInput} value={email} editable={!authenticated} onChangeText={value=>{updateEmail(value);setOtpSent(false);setOtpCode('');}} keyboardType="email-address" autoCapitalize="none" placeholder="Email address" placeholderTextColor="#A69A94"/></View><View style={s.inputWrap}><Phone size={18} color={muted}/><TextInput style={s.contactInput} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Mobile number (optional)" placeholderTextColor="#A69A94"/></View>{otpSent&&!authenticated&&<View style={s.inputWrap}><Mail size={18} color={green}/><TextInput style={s.contactInput} value={otpCode} onChangeText={setOtpCode} keyboardType="number-pad" placeholder="6-digit email sign-in code" placeholderTextColor="#A69A94"/></View>}{curb&&<><Text style={s.settingsSection}>YOUR VEHICLE FOR CURBSIDE</Text><View style={s.inputWrap}><TextInput style={s.contactInput} value={vehicleMake} onChangeText={setVehicleMake} placeholder="Make" placeholderTextColor="#A69A94"/><TextInput style={s.contactInput} value={vehicleModel} onChangeText={setVehicleModel} placeholder="Model" placeholderTextColor="#A69A94"/></View><View style={s.inputWrap}><TextInput style={s.contactInput} value={vehicleColor} onChangeText={setVehicleColor} placeholder="Color" placeholderTextColor="#A69A94"/></View></>}<View style={[s.pickupSummary,{flexWrap:"wrap"}]}><Pressable accessibilityRole="checkbox" accessibilityLabel="Agree to the Consumer Terms and Privacy Policy" accessibilityState={{checked:termsAccepted}} onPress={()=>setTermsAccepted(!termsAccepted)} style={[s.checkbox,termsAccepted&&s.checkboxOn]}>{termsAccepted&&<Check size={14} color="#FFF"/>}</Pressable><Text style={s.checkoutInfoText}>I agree to the</Text><Pressable onPress={()=>openPolicy('consumer-terms')}><Text style={s.summaryEdit}>Consumer Terms</Text></Pressable><Text style={s.checkoutInfoText}>and</Text><Pressable onPress={()=>openPolicy('privacy-policy')}><Text style={s.summaryEdit}>Privacy Policy</Text></Pressable></View><View style={s.checkoutInfo}><PackageCheck size={19} color={green}/><Text style={s.checkoutInfoText}>{supabase?'Email verification links this order to your pickup history.':'No account needed. Payment happens when you pick up.'}</Text></View><View style={{flex:1}}/><View style={s.totalRow}><Text style={s.totalLabel}>Subtotal</Text><Text style={s.totalPrice}>{dollars(subtotal)}</Text></View><Pressable onPress={place} disabled={!email.includes('@')||(supabase&&!termsAccepted)||(supabase&&!authenticated&&otpSent&&otpCode.trim().length<6)} style={[s.primaryBtn,(!email.includes('@')||(supabase&&!termsAccepted)||(supabase&&!authenticated&&otpSent&&otpCode.trim().length<6))&&{opacity:.5}]}><Text style={s.primaryBtnText}>{supabase&&!authenticated&&!otpSent?'Email me a sign-in code':supabase&&!authenticated?'Verify code and place order':'Place pickup order'}</Text><ChevronRight size={19} color="#FFF"/></Pressable><Text style={s.finePrint}>Payment is handled at pickup. No charge now.</Text></ScrollView></KeyboardAvoidingView>}
      {flow==='done'&&<View style={s.doneView}><View style={s.doneIcon}><Check size={32} color="#FFF"/></View><Text style={s.doneEyebrow}>YOU’RE ALL SET</Text><Text style={s.doneTitle}>Dinner is{ '\n' }in motion.</Text><Text style={s.doneSub}>Your order is linked to {email}. Follow pickup progress from Orders.</Text><View style={s.doneCard}><View style={s.doneCardRow}><CalendarDays size={17} color={maroon}/><Text style={s.doneCardText}>{dateLabel(date,active.timezone)} · {slot}</Text></View><View style={s.doneCardRow}><MapPin size={17} color={maroon}/><Text style={s.doneCardText}>{active.name} · {active.address||"Oakland, CA"}</Text></View><View style={s.prepTimeline}><TimelineItem icon={<CircleCheck size={16} color={green}/>} title="Order received" done/><TimelineItem icon={<ChefHat size={16} color={maroon}/>} title="Published prep steps are saved below"/><TimelineItem icon={<Bell size={16} color={muted}/>} title="Check pickup progress in the Orders tab"/></View></View><Pressable onPress={()=>{setFlow('menu');closeKitchen();setTab('Orders')}} style={s.primaryBtn}><Text style={s.primaryBtnText}>View order progress</Text><ChevronRight size={19} color="#FFF"/></Pressable><Pressable onPress={()=>navigate('Home')} style={s.doneLink}><Text style={s.doneLinkText}>Back to browsing</Text></Pressable></View>}
      {flow==='menu'&&!menuLoading&&cartCount>0&&Object.values(cart).every(x=>x.restaurantId===active.id)&&<Pressable style={s.cartBar} accessibilityRole="button" accessibilityLabel="View bag" onPress={()=>navigate('Bag')}><View style={s.cartBubble}><Text style={s.cartBubbleText}>{cartCount}</Text></View><Text style={s.cartBarLabel}>View bag</Text><Text style={s.cartBarPrice}>{dollars(subtotal)}</Text><ChevronRight size={18} color="#FFF"/></Pressable>}
    </Enter>}
    {!active&&<View style={[s.bottomNav,{paddingBottom:Math.max(12,insets.bottom)}]}>{footerTabs.map(({name,Icon})=><Pressable
      key={name} accessibilityRole="tab" accessibilityState={{selected:tab===name}}
      accessibilityLabel={name==='Bag'&&cartCount?`Bag, ${cartCount} ${cartCount===1?'item':'items'}`:name}
      onPress={()=>navigate(name)} style={s.navItem}>
      <View style={s.navIconWrap}><Icon size={21} color={tab===name?maroon:muted}/></View>
      <Text style={[s.navText,tab===name&&s.navTextActive]}>{name}</Text>
      {name==='Bag'&&cartCount>0&&<View style={s.navBadge}><Text style={s.navBadgeTxt}>{cartCount>99?'99+':cartCount}</Text></View>}
    </Pressable>)}</View>}
    {showLocation&&<LocationPicker close={()=>setShowLocation(false)} locating={locating} useDevice={()=>void usePickupLocation()}
      useAddress={({label,latitude,longitude})=>{setOrigin({latitude,longitude});setLocationLabel(label);setShowLocation(false);}}
      reset={()=>{setOrigin(sanFrancisco);setLocationLabel('From San Francisco');setShowLocation(false);}}/>}
    {notice&&<View style={{...StyleSheet.absoluteFillObject,justifyContent:'center',zIndex:30}}><Pressable onPress={()=>setNotice(null)} style={{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(28,18,14,.4)'}}/><View style={{marginHorizontal:28,backgroundColor:ivory,borderRadius:16,padding:21,borderWidth:1,borderColor:line}}><Text style={{fontSize:23,fontWeight:'700',color:ink}}>{notice.title}</Text><Text style={{fontSize:12,color:muted,lineHeight:18,marginTop:9,marginBottom:18}}>{notice.message}</Text><Pressable onPress={()=>setNotice(null)} style={s.primaryBtn}><Text style={s.primaryBtnText}>Got it</Text></Pressable></View></View>}
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

function dayOffset(iso:string,tz?:string){const nowKey=new Intl.DateTimeFormat('en-CA',{timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const dayKey=new Intl.DateTimeFormat('en-CA',{timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));return Math.round((Date.parse(`${dayKey}T12:00:00Z`)-Date.parse(`${nowKey}T12:00:00Z`))/86400000);}
function formatTime(iso:string,tz?:string){return new Intl.DateTimeFormat('en-US',{timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone,hour:'numeric',minute:'2-digit'}).format(new Date(iso));}
function dateLabel(n:number,tz?:string){const d=new Date(Date.now()+n*86400000);return new Intl.DateTimeFormat('en-US',{timeZone:tz||Intl.DateTimeFormat().resolvedOptions().timeZone,weekday:'long',month:'long',day:'numeric'}).format(d);}
const mealImage=foodPhoto, kitchenImage=foodPhoto;
function Option({label,selected,onPress}:{label:string;selected:boolean;onPress:()=>void}) {
  return <Pressable accessibilityRole="checkbox" accessibilityState={{checked:selected}} onPress={onPress}
    style={[s.optionChip,selected&&s.optionChipOn]}>
    <Text style={[s.optionChipText,selected&&{color:maroon}]}>{selected?'✓  ':''}{label}</Text>
  </Pressable>;
}
function PickupDate({date,setDate,next,slots,timezone,address,live}:{date:number;setDate:(n:number)=>void;next:()=>void;live:boolean;slots?:Kitchen['pickupSlots'];timezone?:string;address?:string}){const days=live?[...new Set((slots||[]).map(x=>dayOffset(x.startsAt,timezone)))]:[1,2,3];return <View style={s.checkoutContent}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepCurrent}>2  PICKUP</Text><Text style={s.stepIdle}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>When would you{ '\n' }like to pick up?</Text><Text style={s.checkoutSub}>Choose a day first. We’ll show available kitchen windows next.</Text>{days.map((n,i)=><Pressable key={n} onPress={()=>setDate(n)} style={[s.dateOption,date===n&&s.dateOptionActive]}><View style={[s.radio,date===n&&s.radioActive]}>{date===n&&<View style={s.radioInner}/>}</View><View style={{flex:1}}><Text style={s.dateDay}>{dateLabel(n,timezone)}</Text><Text style={s.dateAvailability}>{slots?.length?`${slots.filter(x=>dayOffset(x.startsAt,timezone)===n).length} pickup windows available`:n===1?'Most pickup windows available':'A few windows available'}</Text></View><Text style={s.datePill}>{live?'AVAILABLE':i===0?'POPULAR':'AVAILABLE'}</Text></Pressable>)}<View style={{flex:1}}/>{live&&days.length===0&&<Text style={s.checkoutSub}>No pickup dates have enough stock for this bag. Return to your bag and adjust quantities.</Text>}<PickupSummary date={date} timezone={timezone} address={address}/><Pressable onPress={next} style={s.primaryBtn}><Text style={s.primaryBtnText}>{live&&!days.length?"Back to bag":"Choose pickup time"}</Text><ChevronRight size={19} color="#FFF"/></Pressable></View>}
function PickupTime({date,slot,setSlot,curb,setCurb,next,available,timezone,address,curbsideEnabled,live}:{date:number;slot:string;live:boolean;setSlot:(v:string)=>void;curb:boolean;setCurb:(v:boolean)=>void;next:()=>void;available?:Kitchen['pickupSlots'];timezone?:string;address?:string;curbsideEnabled:boolean}){const times=live?[...new Set((available||[]).map(x=>formatTime(x.startsAt,timezone)))]:['4:30 PM','5:00 PM','5:30 PM','6:00 PM','6:30 PM','7:00 PM'];return <View style={s.checkoutContent}><View style={s.steps}><Text style={s.stepDone}>1  CART</Text><Text style={s.stepCurrent}>2  PICKUP</Text><Text style={s.stepIdle}>3  DETAILS</Text></View><Text style={s.checkoutTitle}>Pick a time that{ '\n' }works for you.</Text><Text style={s.checkoutSub}>{dateLabel(date,timezone)} · the kitchen will have your meal ready fresh.</Text><View style={s.timeGrid}>{times.map((t,i)=><Pressable key={t} disabled={live&&!available?.some(x=>formatTime(x.startsAt,timezone)===t)} onPress={()=>setSlot(t)} style={[s.timeOption,slot===t&&s.timeOptionActive]}><Text style={[s.timeText,slot===t&&s.timeTextActive]}>{t}</Text>{live&&i===0&&<Text style={s.fewLeft}>FIRST AVAILABLE</Text>}</Pressable>)}</View>{curbsideEnabled&&<Pressable onPress={()=>setCurb(!curb)} style={s.curbRow}><View style={[s.checkbox,curb&&s.checkboxOn]}>{curb&&<Check size={14} color="#FFF"/>}</View><View style={{flex:1}}><View style={s.curbTitleRow}><CarFront size={18} color={maroon}/><Text style={s.curbTitle}>Curbside pickup</Text></View><Text style={s.curbSub}>We’ll bring your order to your car.</Text></View><Text style={s.curbFree}>FREE</Text></Pressable>}<View style={{flex:1}}/>{live&&!times.length&&<Text style={s.checkoutSub}>No pickup windows have enough stock for these items.</Text>}<PickupSummary date={date} slot={slot} curb={curb} timezone={timezone} address={address}/><Pressable onPress={next} style={s.primaryBtn}><Text style={s.primaryBtnText}>{live&&!times.length?"Back to dates":"Continue to details"}</Text><ChevronRight size={19} color="#FFF"/></Pressable></View>}
function PickupSummary({date,slot,curb,timezone,address}:{date:number;slot?:string;curb?:boolean;timezone?:string;address?:string}){return <View style={s.pickupSummary}><MapPin size={17} color={maroon}/><View style={{flex:1}}><Text style={s.pickupSummaryTitle}>PICKUP {address?`· ${address}`:'· OAKLAND'}</Text><Text style={s.pickupSummarySub}>{dateLabel(date,timezone)}{slot?` · ${slot}`:''}{curb?' · Curbside':''}</Text></View><Text style={s.summaryEdit}>EDIT</Text></View>}
function TimelineItem({icon,title,done}:{icon:React.ReactNode;title:string;done?:boolean}){return <View style={s.timelineRow}><View style={s.timelineIcon}>{icon}</View><Text style={[s.timelineText,done&&{color:green}]}>{title}</Text></View>}
function LiveMenuReorder({kitchen,orders,add}:{kitchen:Kitchen;orders:any[];add:(m:Meal,q:number)=>void}){const last=orders.find(o=>o.restaurant_id===kitchen.backendId);const usuals=(last?.order_items||[]).map((x:any)=>({item:x,meal:kitchen.meals.find(m=>m.backendItemId===x.item_id)})).filter((x:any)=>x.meal);if(!usuals.length)return null;return <View style={s.reorderBox}><View style={s.reorderIcon}><CircleCheck size={19} color={green}/></View><View style={{flex:1}}><Text style={s.reorderTitle}>Your usual, from your last order</Text><Text style={s.reorderSub}>Quantity saved from {new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:kitchen.timezone}).format(new Date(last.pickup_starts_at))}.</Text>{usuals.map(({item,meal}:any)=><View key={item.item_id} style={s.savedOrderRow}><Text style={s.savedOrderName}>{meal.name}</Text><Text style={s.savedOrderOpts}>Last order · {item.quantity}×</Text><Pressable onPress={()=>add(meal,item.quantity)} style={s.reorderBtn}><Plus size={14} color="#FFF"/><Text style={s.reorderBtnText}>Add usual</Text></Pressable></View>)}</View></View>}
function LiveOrders({orders}:{orders:any[]}){return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingHorizontal:22,paddingTop:20,paddingBottom:120}}><Text style={s.eyebrow}>YOUR CENA MOMENTS</Text><Text style={s.pageTitle}>Orders</Text>{orders.length===0?<View style={s.profileHero}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>No orders yet</Text><Text style={s.historyDate}>Your pickup orders and prep instructions will show here.</Text></View></View>:orders.map(order=>{const rest=Array.isArray(order.restaurants)?order.restaurants[0]:order.restaurants;const items=order.order_items||[];const date=new Intl.DateTimeFormat('en-US',{timeZone:order.restaurant_timezone||'UTC',weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(order.pickup_starts_at));return <View key={order.id} style={s.orderHistoryCard}><View style={s.historyHead}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>{rest?.name||'Cena kitchen'}</Text><Text style={s.historyDate}>{date} · {order.pickup_mode==='curbside'?'Curbside':'Pickup'}</Text></View><Text style={s.historyPrice}>{dollars(order.subtotal_cents/100)}</Text></View>{items.map((item:any)=><View key={item.item_id} style={s.historyDishes}><Text style={s.historyDish}>{item.quantity}× {item.name_snapshot}</Text>{(item.prep_steps_snapshot||[]).map((step:string,index:number)=><Text key={`${item.item_id}-${index}`} style={s.historyPrefs}>• {step}</Text>)}</View>)}<View style={s.orderStatus}><View style={s.statusDot}/><Text style={s.statusText}>{String(order.status).replace('_',' ')}</Text><Text style={s.statusCode}>{order.id.slice(0,8).toUpperCase()}</Text></View></View>})}</ScrollView>}
function Orders({onRepeat,orders,live}:{onRepeat:(k:Kitchen)=>void;orders:any[];live:boolean}){if(live)return <LiveOrders orders={orders}/>;return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{paddingHorizontal:22,paddingTop:20,paddingBottom:120}}><Text style={s.eyebrow}>YOUR CENA MOMENTS</Text><Text style={s.pageTitle}>Orders</Text><View style={s.orderHistoryCard}><View style={s.historyHead}><View style={s.historyIcon}><PackageCheck size={21} color={green}/></View><View style={{flex:1}}><Text style={s.historyName}>Nonna’s Table</Text><Text style={s.historyDate}>Sunday, November 15 · Pickup</Text></View><Text style={s.historyPrice}>$32.00</Text></View><View style={s.historyDishes}><Text style={s.historyDish}>2× Sunday lasagna</Text><Text style={s.historyPrefs}>Extra parmesan · No parsley</Text></View><View style={s.orderStatus}><View style={s.statusDot}/><Text style={s.statusText}>Picked up · Enjoyed</Text><Text style={s.statusCode}>CN-843921</Text></View><Pressable onPress={()=>onRepeat(demoKitchens[0])} style={s.reorderWide}><Text style={s.reorderWideText}>Order this again</Text><ChevronRight size={17} color={maroon}/></Pressable></View><View style={s.orderHistoryCard}><View style={s.historyHead}><View style={[s.historyIcon,{backgroundColor:'#F4EBDD'}]}><PackageCheck size={21} color="#98643E"/></View><View style={{flex:1}}><Text style={s.historyName}>Sol y Sazón</Text><Text style={s.historyDate}>Thursday, November 12 · Pickup</Text></View><Text style={s.historyPrice}>$13.00</Text></View><View style={s.historyDishes}><Text style={s.historyDish}>1× Mushroom tinga tacos</Text><Text style={s.historyPrefs}>Salsa on the side</Text></View><View style={s.orderStatus}><View style={s.statusDot}/><Text style={s.statusText}>Picked up · Enjoyed</Text><Text style={s.statusCode}>CN-219034</Text></View><Pressable onPress={()=>onRepeat(demoKitchens[1])} style={s.reorderWide}><Text style={s.reorderWideText}>Order this again</Text><ChevronRight size={17} color={maroon}/></Pressable></View></ScrollView>}

const s=StyleSheet.create({homeSectionTitle:{fontSize:22,lineHeight:27,fontWeight:'800',color:ink,marginBottom:12},featuredName:{fontSize:14,lineHeight:18,fontWeight:'700',color:ink,marginTop:7},featuredPrice:{fontSize:13,color:maroon,fontWeight:'700',marginTop:4},screen:{flex:1,backgroundColor:ivory},topbar:{height:58,flexDirection:'row',alignItems:'center',paddingHorizontal:22,gap:14},brand:{flexDirection:'row',alignItems:'center',marginRight:'auto'},wordmark:{fontSize:31,fontWeight:'700',letterSpacing:-2,color:maroon},logodot:{width:6,height:6,borderRadius:4,backgroundColor:'#B97832',marginTop:17,marginLeft:2},location:{flexDirection:'row',alignItems:'center',gap:4},locText:{fontSize:12,color:ink,fontWeight:'600'},avatar:{width:34,height:34,borderRadius:17,backgroundColor:'#EADAD2',alignItems:'center',justifyContent:'center'},avatarTxt:{fontSize:14,fontWeight:'700',color:maroon},eyebrow:{fontSize:10,fontWeight:'700',letterSpacing:1.7,color:muted,marginTop:9,marginBottom:9},heroTitle:{fontSize:36,lineHeight:39,letterSpacing:-.5,color:ink,marginBottom:17},searchbox:{height:50,borderWidth:1,borderColor:line,backgroundColor:'#FFF',borderRadius:12,alignItems:'center',flexDirection:'row',paddingHorizontal:14,gap:10,marginBottom:17},searchInput:{flex:1,minWidth:0,fontSize:16,color:ink},offer:{height:176,backgroundColor:maroon,borderRadius:15,overflow:'hidden',flexDirection:'row',marginBottom:19},offerCopy:{flex:1,padding:16,justifyContent:'center'},offerPill:{alignSelf:'flex-start',flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#773128',borderRadius:20,paddingVertical:5,paddingHorizontal:8,marginBottom:8},offerPillText:{fontSize:8,fontWeight:'800',letterSpacing:1,color:'#FFF'},offerTitle:{fontSize:25,lineHeight:26,color:'#FFF',fontWeight:'700'},offerSub:{fontSize:10,color:'#F0DCD6',marginTop:6},offerDiscount:{borderWidth:1,borderColor:'#BD938A',paddingHorizontal:8,paddingVertical:4,borderRadius:5,alignSelf:'flex-start',marginTop:9},offerDiscountText:{fontSize:9,fontWeight:'800',letterSpacing:.7,color:'#FFF'},offerImage:{width:'38%',height:'100%'},categories:{flexDirection:'row',gap:8,marginBottom:21},category:{minHeight:44,borderRadius:22,borderWidth:1,borderColor:line,paddingVertical:8,paddingHorizontal:13,flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#FFF'},categoryActive:{backgroundColor:maroon,borderColor:maroon},categoryText:{fontSize:13,color:ink,fontWeight:'600'},categoryTextActive:{color:'#FFF'},sectionHeader:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:12,marginTop:3},sectionTitle:{fontSize:21,color:ink,fontWeight:'700',letterSpacing:-.4},sectionHint:{fontSize:11,color:muted,marginTop:4},seeAll:{fontSize:11,color:maroon,fontWeight:'700'},recentScroll:{gap:11,paddingRight:22,paddingBottom:23},recentCard:{width:177,borderRadius:12,backgroundColor:'#FFF',borderWidth:1,borderColor:line,overflow:'hidden'},recentImage:{width:'100%',height:100,backgroundColor:'#E9E3DF'},recentBody:{padding:10},pastTag:{flexDirection:'row',alignItems:'center',gap:4},pastText:{fontSize:8,fontWeight:'800',letterSpacing:.7,color:green},recentName:{fontSize:13,fontWeight:'700',color:ink,marginTop:6},recentRestaurant:{fontSize:10,color:muted,marginTop:2},recentBottom:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginTop:7},recentPrice:{fontSize:13,fontWeight:'700',color:maroon},quickAdd:{width:26,height:26,borderRadius:13,borderWidth:1,borderColor:'#E2D2CD',alignItems:'center',justifyContent:'center'},kitchenCard:{backgroundColor:'#FFF',borderRadius:14,overflow:'hidden',borderWidth:1,borderColor:line,marginBottom:14},kitchenImage:{width:'100%',backgroundColor:'#E9E3DF'},kitchenDeal:{position:'absolute',bottom:9,left:10,backgroundColor:maroon,borderRadius:5,paddingVertical:5,paddingHorizontal:8},kitchenDealText:{color:'#FFF',fontSize:8,fontWeight:'800',letterSpacing:.8},heartBtn:{position:'absolute',right:10,top:10,width:32,height:32,borderRadius:16,backgroundColor:'rgba(30,20,15,.40)',alignItems:'center',justifyContent:'center'},kitchenBody:{flexDirection:'row',alignItems:'center',paddingHorizontal:13,paddingTop:12},kitchenName:{fontSize:18,color:ink,fontWeight:'700'},kitchenCuisine:{fontSize:11,color:muted,marginTop:3},rating:{flexDirection:'row',gap:4,alignItems:'center',backgroundColor:'#FBF4EB',paddingHorizontal:8,paddingVertical:6,borderRadius:8},ratingText:{fontSize:11,fontWeight:'700',color:ink},kitchenFoot:{flexDirection:'row',alignItems:'center',padding:13,paddingTop:10,gap:7},metaItem:{flexDirection:'row',alignItems:'center',gap:5},metaText:{fontSize:10,color:muted},dotSep:{color:'#C9BCB6'},fromPrice:{fontSize:10,fontWeight:'700',color:maroon,marginLeft:'auto'},bottomNav:{position:'absolute',bottom:0,left:0,right:0,backgroundColor:'#FFF',borderTopWidth:1,borderTopColor:line,height:73,flexDirection:'row',justifyContent:'space-around',alignItems:'center',paddingTop:6},navItem:{alignItems:'center',justifyContent:'center',width:80,position:'relative'},navIconWrap:{height:25},navText:{fontSize:9,color:muted,marginTop:2},navTextActive:{color:maroon,fontWeight:'700'},navBadge:{position:'absolute',top:-3,right:21,backgroundColor:maroon,width:15,height:15,borderRadius:8,alignItems:'center',justifyContent:'center'},navBadgeTxt:{fontSize:9,color:'#FFF',fontWeight:'700'},modalPage:{flex:1,backgroundColor:ivory},modalTop:{height:51,paddingHorizontal:21,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},backBtn:{width:32,height:32,alignItems:'flex-start',justifyContent:'center'},modalBrand:{fontWeight:'700',fontSize:23,color:maroon,letterSpacing:-1},restaurantHero:{justifyContent:'flex-end'},imageShade:{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(20,9,6,.30)'},restaurantHeroBottom:{padding:19},restaurantLabel:{color:'#F3DDD3',fontSize:8,fontWeight:'800',letterSpacing:1.4},restaurantName:{fontSize:34,color:'#FFF',fontWeight:'700',marginTop:3},restaurantDesc:{fontSize:12,color:'#FFF',marginTop:2},restaurantMeta:{height:48,flexDirection:'row',alignItems:'center',paddingHorizontal:19,gap:19,borderBottomWidth:1,borderBottomColor:line},cutoff:{margin:15,marginBottom:18,padding:12,borderRadius:10,borderWidth:1,borderColor:'#A6C2A9',backgroundColor:'#F4F8F2',flexDirection:'row',alignItems:'center',gap:9},cutoffTitle:{fontSize:9,fontWeight:'800',letterSpacing:.7,color:green},cutoffSub:{fontSize:10,color:'#617464',marginTop:3},countdown:{fontSize:11,color:green,fontWeight:'800',fontVariant:['tabular-nums']},menuTitleRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:18,marginBottom:11},dealBadge:{fontSize:8,color:green,fontWeight:'800',borderWidth:1,borderColor:'#B8CCB8',borderRadius:5,paddingHorizontal:7,paddingVertical:5},reorderBox:{marginHorizontal:15,marginBottom:10,padding:12,backgroundColor:'#F1F6EF',borderWidth:1,borderColor:'#D7E5D6',borderRadius:11,flexDirection:'row',gap:9},reorderIcon:{width:29,height:29,borderRadius:15,backgroundColor:'#FFF',alignItems:'center',justifyContent:'center'},reorderTitle:{fontSize:12,fontWeight:'700',color:green},reorderSub:{fontSize:9,color:'#617464',marginTop:3,marginBottom:9},savedOrderRow:{borderTopWidth:1,borderTopColor:'#D9E7D7',paddingTop:8,marginTop:2,marginBottom:1},savedOrderName:{fontSize:11,fontWeight:'700',color:ink},savedOrderOpts:{fontSize:9,color:muted,marginTop:2},reorderBtn:{height:29,alignSelf:'flex-start',marginTop:7,backgroundColor:green,borderRadius:7,flexDirection:'row',alignItems:'center',paddingHorizontal:9,gap:5},reorderBtnText:{fontSize:10,color:'#FFF',fontWeight:'700'},mealRow:{minHeight:130,paddingVertical:14,paddingHorizontal:18,borderBottomWidth:1,borderColor:line,flexDirection:'row',alignItems:'center',gap:12},mealText:{flex:1},mealTags:{flexDirection:'row',gap:5,marginBottom:4},mealTag:{fontSize:8,color:'#9B6233',fontWeight:'800',letterSpacing:.7},equipmentTag:{fontSize:8,color:'#A1382C',fontWeight:'800',letterSpacing:.6,backgroundColor:'#FCEBE8',paddingHorizontal:5,paddingVertical:3,borderRadius:3},mealName:{fontSize:15,fontWeight:'700',color:ink},mealDesc:{fontSize:10,color:muted,marginTop:4,lineHeight:14},prices:{flexDirection:'row',alignItems:'center',gap:7,marginTop:7},mealPrice:{fontSize:12,color:maroon,fontWeight:'800'},oldPrice:{fontSize:10,color:'#9B908A',textDecorationLine:'line-through'},inCart:{fontSize:9,color:green,fontWeight:'700',marginTop:5},mealImage:{width:92,height:92,borderRadius:9,backgroundColor:'#E9E3DF'},addBubble:{position:'absolute',right:-5,bottom:-5,width:30,height:30,borderRadius:15,backgroundColor:'#FFF',borderWidth:1,borderColor:line,alignItems:'center',justifyContent:'center',elevation:2},cartBar:{position:'absolute',bottom:12,left:16,right:16,height:53,borderRadius:12,backgroundColor:maroon,flexDirection:'row',alignItems:'center',paddingHorizontal:14,gap:10,elevation:4},cartBubble:{width:23,height:23,borderRadius:12,backgroundColor:'#FFF',alignItems:'center',justifyContent:'center'},cartBubbleText:{fontSize:11,fontWeight:'800',color:maroon},cartBarLabel:{fontSize:13,color:'#FFF',fontWeight:'700',flex:1},cartBarPrice:{fontSize:13,color:'#FFF',fontWeight:'700'},checkoutContent:{flex:1,paddingHorizontal:23,paddingTop:12,paddingBottom:13},steps:{flexDirection:'row',gap:13,marginBottom:25},stepDone:{fontSize:9,color:green,fontWeight:'800',letterSpacing:.7},stepCurrent:{fontSize:9,color:maroon,fontWeight:'800',letterSpacing:.7},stepIdle:{fontSize:9,color:'#B4A9A4',fontWeight:'700',letterSpacing:.7},checkoutTitle:{fontSize:30,lineHeight:34,color:ink,fontWeight:'700',letterSpacing:-.6},checkoutSub:{fontSize:12,color:muted,lineHeight:18,marginTop:8,marginBottom:23},dateOption:{minHeight:69,borderWidth:1,borderColor:line,borderRadius:11,backgroundColor:'#FFF',marginBottom:9,paddingHorizontal:13,flexDirection:'row',alignItems:'center',gap:11},dateOptionActive:{borderColor:maroon,backgroundColor:'#FFF9F6'},radio:{width:19,height:19,borderRadius:10,borderWidth:1.5,borderColor:'#CBBDB6',alignItems:'center',justifyContent:'center'},radioActive:{borderColor:maroon},radioInner:{width:9,height:9,borderRadius:5,backgroundColor:maroon},dateDay:{fontSize:13,fontWeight:'700',color:ink},dateAvailability:{fontSize:10,color:muted,marginTop:4},datePill:{fontSize:8,color:green,fontWeight:'800',letterSpacing:.5},pickupSummary:{height:56,borderTopWidth:1,borderTopColor:line,flexDirection:'row',alignItems:'center',gap:10,marginBottom:9},pickupSummaryTitle:{fontSize:9,fontWeight:'800',letterSpacing:.7,color:ink},pickupSummarySub:{fontSize:10,color:muted,marginTop:3},summaryEdit:{fontSize:9,color:maroon,fontWeight:'800',letterSpacing:.5},primaryBtn:{height:52,backgroundColor:maroon,borderRadius:11,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8},primaryBtnText:{fontSize:13,color:'#FFF',fontWeight:'700'},timeGrid:{flexDirection:'row',flexWrap:'wrap',gap:9,marginBottom:22},timeOption:{height:51,width:'31.5%',borderRadius:9,borderWidth:1,borderColor:line,backgroundColor:'#FFF',alignItems:'center',justifyContent:'center'},timeOptionActive:{borderColor:maroon,backgroundColor:'#FFF8F5'},timeText:{fontSize:11,color:ink,fontWeight:'600'},timeTextActive:{color:maroon,fontWeight:'800'},fewLeft:{fontSize:7,color:'#9D6843',fontWeight:'800',marginTop:3},curbRow:{minHeight:74,borderWidth:1,borderColor:line,borderRadius:10,backgroundColor:'#FFF',padding:12,flexDirection:'row',alignItems:'center',gap:10},checkbox:{width:20,height:20,borderWidth:1,borderColor:'#C6BAB4',borderRadius:5,alignItems:'center',justifyContent:'center'},checkboxOn:{backgroundColor:maroon,borderColor:maroon},curbTitleRow:{flexDirection:'row',alignItems:'center',gap:6},curbTitle:{fontSize:12,fontWeight:'700',color:ink},curbSub:{fontSize:10,color:muted,marginTop:4},curbFree:{fontSize:9,color:green,fontWeight:'800'},totalRow:{height:42,flexDirection:'row',alignItems:'center',justifyContent:'space-between'},totalLabel:{fontSize:11,color:muted},totalPrice:{fontSize:16,fontWeight:'800',color:ink},finePrint:{fontSize:9,color:muted,textAlign:'center',marginTop:9},inputWrap:{height:51,borderWidth:1,borderColor:line,backgroundColor:'#FFF',borderRadius:10,marginBottom:10,paddingHorizontal:14,flexDirection:'row',alignItems:'center',gap:10},contactInput:{fontSize:13,color:ink,flex:1},checkoutInfo:{flexDirection:'row',gap:9,backgroundColor:'#F0F6EF',padding:12,borderRadius:9,marginTop:5,alignItems:'center'},checkoutInfoText:{fontSize:10,lineHeight:15,color:'#526557',flex:1},doneView:{flex:1,paddingHorizontal:24,paddingTop:30,paddingBottom:19,alignItems:'center'},doneIcon:{width:58,height:58,borderRadius:29,backgroundColor:green,alignItems:'center',justifyContent:'center',marginBottom:19},doneEyebrow:{fontSize:9,fontWeight:'800',letterSpacing:1.4,color:green},doneTitle:{fontSize:42,lineHeight:44,color:ink,fontWeight:'700',textAlign:'center',marginTop:8},doneSub:{fontSize:12,lineHeight:18,color:muted,textAlign:'center',marginTop:11,maxWidth:290},doneCard:{width:'100%',borderWidth:1,borderColor:line,borderRadius:12,backgroundColor:'#FFF',padding:15,marginTop:22,marginBottom:20},doneCardRow:{flexDirection:'row',alignItems:'center',gap:9,marginVertical:5},doneCardText:{fontSize:11,fontWeight:'600',color:ink},prepTimeline:{borderTopWidth:1,borderColor:line,marginTop:10,paddingTop:10},timelineRow:{flexDirection:'row',alignItems:'center',gap:9,minHeight:33},timelineIcon:{width:20,alignItems:'center'},timelineText:{fontSize:10,color:muted},doneLink:{padding:12},doneLinkText:{fontSize:11,color:maroon,fontWeight:'700'},sheetOverlay:{...StyleSheet.absoluteFillObject,justifyContent:'flex-end'},scrim:{...StyleSheet.absoluteFillObject,backgroundColor:'rgba(28,18,14,.38)'},sheet:{backgroundColor:ivory,borderTopLeftRadius:20,borderTopRightRadius:20,paddingHorizontal:21,paddingTop:9},sheetHandle:{width:38,height:4,borderRadius:3,backgroundColor:'#D8CCC6',alignSelf:'center',marginBottom:16},sheetHead:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginBottom:18},sheetTitle:{fontSize:23,color:ink,fontWeight:'700'},sheetSub:{fontSize:10,color:muted,marginTop:4,maxWidth:255},sheetPrice:{fontSize:16,fontWeight:'800',color:maroon},warningBox:{borderWidth:1,borderColor:'#E5AAA1',backgroundColor:'#FFF0ED',padding:11,borderRadius:8,marginBottom:15},warningTitle:{fontSize:11,fontWeight:'800',color:'#A23B30'},warningSub:{fontSize:9,lineHeight:14,color:'#87544D',marginTop:4},optionLabel:{fontSize:9,color:muted,fontWeight:'800',letterSpacing:1},optionChips:{flexDirection:'row',gap:6,marginTop:9,marginBottom:19},optionChip:{paddingHorizontal:9,paddingVertical:8,borderWidth:1,borderColor:line,borderRadius:20,backgroundColor:'#FFF'},optionChipOn:{borderColor:'#B77A6E',backgroundColor:'#F7EBE8'},optionChipText:{fontSize:9,color:ink},qtyRow:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:18},qtyControl:{height:35,width:104,borderWidth:1,borderColor:line,borderRadius:8,backgroundColor:'#FFF',flexDirection:'row',alignItems:'center',justifyContent:'space-around'},qtyValue:{fontSize:13,fontWeight:'700',color:ink},pageTitle:{fontSize:35,fontWeight:'700',color:ink,letterSpacing:-.8,marginBottom:20},orderHistoryCard:{borderWidth:1,borderColor:line,borderRadius:13,backgroundColor:'#FFF',padding:14,marginBottom:13},historyHead:{flexDirection:'row',alignItems:'center',gap:10},historyIcon:{width:38,height:38,borderRadius:10,backgroundColor:'#EFF5ED',alignItems:'center',justifyContent:'center'},historyName:{fontSize:14,fontWeight:'700',color:ink},historyDate:{fontSize:10,color:muted,marginTop:3},historyPrice:{fontSize:12,fontWeight:'700',color:ink},historyDishes:{marginLeft:48,marginTop:12},historyDish:{fontSize:11,color:ink,fontWeight:'600'},historyPrefs:{fontSize:10,color:muted,marginTop:4},orderStatus:{borderTopWidth:1,borderColor:line,marginTop:12,paddingTop:11,flexDirection:'row',alignItems:'center',gap:6},statusDot:{width:7,height:7,borderRadius:4,backgroundColor:green},statusText:{fontSize:10,color:green,fontWeight:'600'},statusCode:{fontSize:9,color:muted,marginLeft:'auto'},reorderWide:{height:37,borderWidth:1,borderColor:'#E2D1CB',borderRadius:8,marginTop:11,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:5},reorderWideText:{fontSize:11,color:maroon,fontWeight:'700'},profileHero:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:'#FFF',borderRadius:12,borderWidth:1,borderColor:line,marginBottom:21},profileAvatar:{width:46,height:46,borderRadius:23,backgroundColor:'#EADAD2',alignItems:'center',justifyContent:'center'},profileInitial:{fontSize:19,color:maroon,fontWeight:'700'},profileName:{fontSize:17,color:ink,fontWeight:'700'},profileHint:{fontSize:10,color:muted,marginTop:3},settingsSection:{fontSize:9,fontWeight:'800',letterSpacing:1.1,color:muted,marginTop:12,marginBottom:7},settingRow:{minHeight:61,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:1,borderBottomColor:line},settingIcon:{width:34,height:34,borderRadius:9,backgroundColor:'#F2E9E5',alignItems:'center',justifyContent:'center'},settingTitle:{fontSize:12,fontWeight:'700',color:ink},settingDesc:{fontSize:10,color:muted,marginTop:3},accountFooter:{fontStyle:'italic',textAlign:'center',color:'#9A8981',fontSize:13,marginTop:32}});
