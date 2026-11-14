package com.cena.restaurant
import android.app.*;import android.content.Intent;import android.net.Uri;import android.os.*;import android.graphics.Color;import android.graphics.drawable.GradientDrawable;import android.view.*;import android.widget.*;import org.json.*;import java.net.*;import java.util.concurrent.Executors
class MainActivity:Activity(){private val bg=Color.rgb(250,246,243);private val paper=Color.rgb(255,253,250);private val peach=Color.rgb(255,240,232);private val rose=Color.rgb(233,207,196);private val coral=Color.rgb(197,119,96);private val clay=Color.rgb(133,87,74);private val ink=Color.rgb(39,29,25);private val wine=Color.rgb(93,16,10);private val ex=Executors.newSingleThreadExecutor();private lateinit var body:LinearLayout;private val pref by lazy{getSharedPreferences("merchant",0)};private var rid="";private var rname="";private var rtimezone="America/Los_Angeles";private var merchantRole="staff";private var curb=false;private var awaitingStripeReturn=false
 override fun onCreate(b:Bundle?){super.onCreate(b);window.statusBarColor=bg;window.navigationBarColor=bg;window.decorView.systemUiVisibility=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;awaitingStripeReturn=isStripeReturn(intent.data);if(pref.getString("token",null)!=null)loadRestaurants()else login()}
 override fun onResume(){super.onResume();if(awaitingStripeReturn&&rid.isNotBlank()){awaitingStripeReturn=false;paymentSetup()}}
 override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);if(isStripeReturn(intent.data)){awaitingStripeReturn=true;if(rid.isNotBlank()){awaitingStripeReturn=false;paymentSetup()}else if(pref.getString("token",null)!=null)loadRestaurants()}}
 private fun isStripeReturn(uri:Uri?):Boolean=uri?.scheme=="cena-restaurant"&&uri.host=="connect"&&uri.path=="/return"
 private fun base(){val sc=ScrollView(this);val outer=LinearLayout(this).apply{orientation=1;gravity=Gravity.CENTER_HORIZONTAL;setBackgroundColor(bg)};body=LinearLayout(this).apply{orientation=1;setPadding(22,22,22,24);setBackgroundColor(bg);layoutParams=LinearLayout.LayoutParams(-1,-2).apply{width=resources.displayMetrics.widthPixels.coerceAtMost((680*resources.displayMetrics.density).toInt())}};outer.addView(body);sc.addView(outer);setContentView(sc)};private fun title(s:String,z:Float=25f){body.addView(TextView(this).apply{text=s;textSize=z;setTextColor(wine);setPadding(12,9,12,9);typeface=android.graphics.Typeface.DEFAULT_BOLD;background=GradientDrawable().apply{setColor(paper);cornerRadius=13*resources.displayMetrics.density;setStroke((1*resources.displayMetrics.density).toInt(),coral)}})};private fun text(s:String){body.addView(TextView(this).apply{text=s;textSize=15f;setTextColor(clay);setPadding(0,5,0,10)})};private fun button(s:String,f:()->Unit){body.addView(Button(this).apply{text=s;setTextColor(-1);background=GradientDrawable().apply{setColor(wine);cornerRadius=(16f+((390f-resources.displayMetrics.widthPixels/resources.displayMetrics.density)/110f*10f)).coerceIn(16f,26f)*resources.displayMetrics.density};setOnClickListener{f()}})};private fun field(s:String):EditText{val e=EditText(this).apply{hint=s};body.addView(e);return e}
 private fun go(task:()->String,done:(String)->Unit){ex.execute{try{val x=task();runOnUiThread{done(x)}}catch(e:Exception){runOnUiThread{Toast.makeText(this,e.message?:"Request failed",Toast.LENGTH_LONG).show()}}}};private fun req(path:String,method:String="GET",data:JSONObject?=null):String{val c=URL(BuildConfig.SUPABASE_URL.trimEnd('/')+path).openConnection() as HttpURLConnection;c.requestMethod=method;c.connectTimeout=9000;c.readTimeout=12000;c.setRequestProperty("apikey",BuildConfig.SUPABASE_KEY);c.setRequestProperty("Authorization","Bearer "+(pref.getString("token",BuildConfig.SUPABASE_KEY)?:BuildConfig.SUPABASE_KEY));c.setRequestProperty("Content-Type","application/json");if(data!=null){c.doOutput=true;c.outputStream.use{it.write(data.toString().toByteArray())}};val st=if(c.responseCode<400)c.inputStream else c.errorStream;val out=st.bufferedReader().readText();if(c.responseCode>=400)throw Exception(out);return out}
private fun apiReq(path:String,method:String="GET",data:JSONObject?=null):String{val c=URL(BuildConfig.CENA_API_URL.trimEnd('/')+path).openConnection() as HttpURLConnection;c.requestMethod=method;c.connectTimeout=8000;c.readTimeout=12000;pref.getString("token",null)?.let{c.setRequestProperty("Authorization","Bearer $it")};c.setRequestProperty("Content-Type","application/json");if(data!=null){c.doOutput=true;c.outputStream.use{it.write(data.toString().toByteArray())}};val code=c.responseCode;val stream=if(code<400)c.inputStream else c.errorStream;val result=stream.bufferedReader().readText();if(code>=400)throw Exception(result);return result}
 private fun trustedOnboardingUrl(url:String):Boolean{try{val uri=java.net.URI(url);return uri.scheme=="https"&&uri.host.equals("connect.stripe.com",true)&&uri.userInfo==null}catch(_:Exception){return false}}
 private fun paymentSetup(){go({apiReq("/v1/restaurants/$rid/payments")}){val info=JSONObject(it);val status=info.optString("status");base();title("Cena payments");when(status){"ready"->{text("Stripe is connected. New customer orders can be paid in Cena.");val fee=info.optInt("application_fee_cents",0);if(fee>0)text("Cena platform fee · $${"%.2f".format(fee/100.0)} per order.")};"pending"->{text("Stripe setup is in progress.");button("Refresh payment status"){paymentSetup()}};"not_connected"->{text("Connect your restaurant's Stripe account to accept in-app payments.");button("Set up Stripe securely"){go({apiReq("/v1/restaurants/$rid/stripe-onboarding","POST")}){val url=JSONObject(it).optString("url");if(!trustedOnboardingUrl(url)){Toast.makeText(this,"Stripe setup link could not be verified.",Toast.LENGTH_LONG).show()}else try{startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))}catch(_:Exception){Toast.makeText(this,"Could not open Stripe setup.",Toast.LENGTH_LONG).show()}}}};else->text("Payment status is unavailable. Try again shortly.")};button("Back to restaurant"){dashboard()}}}
 private fun login(){base();title("Cena for Restaurants");text("Manage today's reservations and pickup service.");val e=field("Staff email");val p=field("Password");p.inputType=129;button("Sign in"){go({val s=req("/auth/v1/token?grant_type=password","POST",JSONObject().put("email",e.text.toString().trim()).put("password",p.text.toString()));JSONObject(s).getString("access_token")}){pref.edit().putString("token",it).apply();loadRestaurants()}};if(BuildConfig.SUPABASE_URL.isBlank())text("Connect Supabase by setting SUPABASE_URL and SUPABASE_KEY in gradle.properties.")}
 private fun loadRestaurants(){go({req("/rest/v1/merchant_memberships?select=role,restaurant:restaurants(id,name,address,curbside_enabled,timezone)")}){val a=JSONArray(it);base();title("Your restaurants");if(a.length()==0)text("No restaurant membership is connected to this account.");for(i in 0 until a.length()){val membership=a.getJSONObject(i);val r=membership.optJSONObject("restaurant")?:continue;button("${r.optString("name")}\n${r.optString("address")}"){rid=r.optString("id");merchantRole=membership.optString("role","staff");rname=r.optString("name");rtimezone=r.optString("timezone","America/Los_Angeles");curb=r.optBoolean("curbside_enabled");dashboard();if(awaitingStripeReturn){awaitingStripeReturn=false;paymentSetup()}}};button("Sign out"){pref.edit().clear().apply();login()}}}
 private fun promotionsScreen(){go({req("/rest/v1/rpc/list_restaurant_promotions","POST",JSONObject().put("p_restaurant_id",rid))}){renderPromotions(JSONArray(it))}}
 private fun renderPromotions(promos:JSONArray){base();title("Promo codes");text("Restaurant-funded discounts · no code is active until you enable it.");button("+ Create promo code"){promotionForm(null)};button("Refresh promo codes"){promotionsScreen()};if(promos.length()==0)text("No promotion codes yet.");for(i in 0 until promos.length()){val p=promos.getJSONObject(i);val code=p.optString("code");val active=p.optBoolean("active");val now=java.time.Instant.now();val starts=runCatching{java.time.Instant.parse(p.optString("starts_at"))}.getOrNull();val ends=runCatching{java.time.Instant.parse(p.optString("ends_at"))}.getOrNull();val state=when{!active->"Paused";starts!=null&&starts.isAfter(now)->"Scheduled";ends!=null&&!ends.isAfter(now)->"Ended";else->"Active"};title("$code · ${p.optInt("discount_percent")}% off",18f);text("$state · ${p.optInt("redemption_count")} redeemed${if(p.isNull("max_redemptions"))"" else " / ${p.optInt("max_redemptions")}"} · ${p.optInt("reserved_redemptions")} reserved\nStarts ${p.optString("starts_at").replace("T"," ").take(16)}${if(p.isNull("ends_at"))"" else " · Ends ${p.optString("ends_at").replace("T"," ").take(16)}"}");button(if(active)"Pause $code" else "Enable $code"){go({req("/rest/v1/rpc/save_restaurant_promotion","POST",JSONObject().put("p_restaurant_id",rid).put("p_code",code).put("p_discount_percent",p.optInt("discount_percent")).put("p_starts_at",p.optString("starts_at")).put("p_ends_at",if(p.isNull("ends_at"))JSONObject.NULL else p.optString("ends_at")).put("p_max_redemptions",if(p.isNull("max_redemptions"))JSONObject.NULL else p.optInt("max_redemptions")).put("p_active",!active)).toString()}){promotionsScreen()}};button("Edit $code"){promotionForm(p)}};button("Back to restaurant"){dashboard()}}
 private fun promotionForm(existing:JSONObject?){base();title(if(existing==null)"New promo code" else "Edit promo code");val pattern=java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");val zone=runCatching{java.time.ZoneId.of(rtimezone)}.getOrDefault(java.time.ZoneId.of("America/Los_Angeles"));val code=field("Code (3–32 letters, digits, _ or -)");code.setText(existing?.optString("code")?:"");code.isEnabled=existing==null;code.isSingleLine=true;code.filters=arrayOf(android.text.InputFilter.LengthFilter(32));code.inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;val percent=field("Discount percent (1–90)");percent.inputType=android.text.InputType.TYPE_CLASS_NUMBER;percent.setText(existing?.optInt("discount_percent")?.toString()?:"10");fun local(value:String?):String{if(value.isNullOrBlank())return "";return runCatching{java.time.LocalDateTime.ofInstant(java.time.Instant.parse(value),zone).format(pattern)}.getOrDefault("")};val starts=field("Starts · local time YYYY-MM-DD HH:mm");starts.setText(local(existing?.optString("starts_at")?.takeIf{it!="null"}).ifBlank{java.time.LocalDateTime.now(zone).plusMinutes(5).withSecond(0).withNano(0).format(pattern)});val ends=field("Ends · optional local time YYYY-MM-DD HH:mm");ends.setText(local(existing?.optString("ends_at")?.takeIf{it!="null"}));val max=field("Maximum redemptions · optional");max.inputType=android.text.InputType.TYPE_CLASS_NUMBER;max.setText(existing?.optInt("max_redemptions")?.takeIf{it>0}?.toString()?:"");val enabled=CheckBox(this).apply{text="Enable code";setTextColor(wine);isChecked=existing?.optBoolean("active")?:false};body.addView(enabled);val error=TextView(this).apply{setTextColor(Color.rgb(160,45,35));textSize=13f};body.addView(error);button(if(existing==null)"Save promo code" else "Save changes"){val normalized=code.text.toString().trim().uppercase(java.util.Locale.ROOT);val pct=percent.text.toString().toIntOrNull();val maxCount=max.text.toString().trim().takeIf{it.isNotEmpty()}?.toIntOrNull();val parsedStart=runCatching{java.time.LocalDateTime.parse(starts.text.toString().trim(),pattern)}.getOrNull();val parsedEnd=ends.text.toString().trim().takeIf{it.isNotEmpty()}?.let{runCatching{java.time.LocalDateTime.parse(it,pattern)}.getOrNull()};when{!normalized.matches(Regex("^[A-Z0-9][A-Z0-9_-]{2,31}$"))->error.text="Enter a 3–32 character code using letters, digits, hyphens, or underscores.";pct==null||pct !in 1..90->error.text="Discount must be between 1 and 90 percent.";parsedStart==null->error.text="Enter a start time as YYYY-MM-DD HH:mm.";ends.text.isNotBlank()&&parsedEnd==null->error.text="Enter an end time as YYYY-MM-DD HH:mm.";parsedEnd!=null&&!parsedEnd.isAfter(parsedStart)->error.text="End time must be after start time.";max.text.isNotBlank()&&(maxCount==null||maxCount<1)->error.text="Maximum redemptions must be a positive number.";else->{val startsIso=parsedStart.atZone(zone).toInstant().toString();val endsIso=parsedEnd?.atZone(zone)?.toInstant()?.toString();val payload=JSONObject().put("p_restaurant_id",rid).put("p_code",normalized).put("p_discount_percent",pct).put("p_starts_at",startsIso).put("p_ends_at",endsIso?:JSONObject.NULL).put("p_max_redemptions",maxCount?:JSONObject.NULL).put("p_active",enabled.isChecked);go({req("/rest/v1/rpc/save_restaurant_promotion","POST",payload).let{"saved"}}){promotionsScreen()}}}};button("Back to promo codes"){promotionsScreen()}} private fun dashboard(){base();title(rname);text("Today's pickup operations");button(if(curb)"Curbside pickup: ON" else "Curbside pickup: OFF"){go({req("/rest/v1/restaurants?id=eq.$rid","PATCH",JSONObject().put("curbside_enabled",!curb));"ok"}){curb=!curb;dashboard()}};button("Refresh orders"){orders()};button("Payment setup"){paymentSetup()};button("Manage meal kits"){catalogScreen()};if(merchantRole=="owner"||merchantRole=="manager")button("Manage promo codes"){promotionsScreen()};ordersInline()}
 private fun catalogScreen() {
  go({
   val items = JSONArray(req("/rest/v1/catalog_items?select=id,name,description,price_cents,regular_price_cents,prepared_meal_total_cents,equipment,allergens,active,published_steps,published_at,created_at&restaurant_id=eq.$rid&order=created_at.desc"))
   val drafts = JSONArray(req("/rest/v1/prep_drafts?select=id,catalog_item_id,name,source_steps,generated_steps,active,updated_at&restaurant_id=eq.$rid&order=updated_at.desc"))
   JSONObject().put("items", items).put("drafts", drafts).toString()
  }) { result ->
   val data = JSONObject(result)
   renderCatalog(data.getJSONArray("items"), data.getJSONArray("drafts"))
  }
 }

 private fun renderCatalog(items: JSONArray, drafts: JSONArray) {
  base()
  title("Meal kits")
  text("Edit menu details and review pickup instructions before publishing.")
  button("+ Add meal kit") { catalogForm(null, null) }
  button("Refresh meal kits") { catalogScreen() }
  if (items.length() == 0) text("No meal kits yet. Add one to start a private draft.")

  for (index in 0 until items.length()) {
   val item = items.getJSONObject(index)
   val itemId = item.optString("id")
   var draft: JSONObject? = null
   for (draftIndex in 0 until drafts.length()) {
    val candidate = drafts.getJSONObject(draftIndex)
    if (candidate.optString("catalog_item_id") == itemId) {
     draft = candidate
     break
    }
   }
   val published = !item.isNull("published_at")
   val status = if (published) "Published" else "Draft"
   val availability = if (item.optBoolean("active")) "Available" else "Paused"
   title(item.optString("name"), 18f)
   text("${formatDollars(item.optInt("price_cents"))} · $status · $availability")
   button("Edit ${item.optString("name")}") { catalogForm(item, draft) }
  }
  button("Back to restaurant") { dashboard() }
 }

 private fun formatDollars(cents: Int): String =
  String.format(java.util.Locale.ROOT, "$%.2f", cents / 100.0)

 private fun csvValues(value: String): JSONArray {
  val result = JSONArray()
  value.split(",").map { it.trim() }.filter { it.isNotEmpty() }.distinct().forEach(result::put)
  return result
 }

 private fun stepValues(value: String): JSONArray {
  val result = JSONArray()
  value.lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach(result::put)
  return result
 }

 private fun validStepSet(steps: JSONArray, required: Boolean): Boolean {
  val validCount = if (required) steps.length() in 1..80 else steps.length() in 0..80
  return validCount && (0 until steps.length()).all { index ->
   val step = steps.optString(index).trim()
   step.isNotEmpty() && step.length <= 2000
  }
 }

 private fun stepText(values: JSONArray?): String {
  if (values == null) return ""
  return (0 until values.length()).map(values::optString).joinToString("\n")
 }

 private fun centsText(item: JSONObject?, key: String): String {
  if (item == null || item.isNull(key)) return ""
  return String.format(java.util.Locale.ROOT, "%.2f", item.optInt(key) / 100.0)
 }

 private fun parseCents(value: String): Int? {
  val normalized = value.trim()
  if (!normalized.matches(Regex("^\\d{1,6}(?:\\.\\d{1,2})?$"))) return null
  return runCatching { normalized.toBigDecimal().movePointRight(2).intValueExact() }.getOrNull()
 }

 private fun catalogForm(item: JSONObject?, draft: JSONObject?) {
  base()
  title(if (item == null) "New meal kit" else "Edit meal kit")
  text("Chef source notes stay private. Review generated suggestions before publishing customer pickup instructions.")

  val name = field("Meal kit name").apply {
   isSingleLine = true
   setText(item?.optString("name") ?: "")
  }
  val description = field("Description").apply {
   minLines = 2
   setText(item?.optString("description") ?: "")
  }
  val kitPrice = field("Meal-kit price in dollars").apply {
   inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
   setText(centsText(item, "price_cents"))
  }
  val regularPrice = field("Optional regular menu price before tax · dollars").apply {
   inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
   setText(centsText(item, "regular_price_cents"))
  }
  val preparedTotal = field("Optional prepared-meal total including tax · dollars").apply {
   inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL
   setText(centsText(item, "prepared_meal_total_cents"))
  }
  val equipment = field("Equipment · comma separated").apply {
   setText(item?.optJSONArray("equipment")?.let { stepText(it).replace("\n", ", ") } ?: "")
  }
  val allergens = field("Allergens · comma separated").apply {
   setText(item?.optJSONArray("allergens")?.let { stepText(it).replace("\n", ", ") } ?: "")
  }
  val source = field("Private chef notes · one per line").apply {
   inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
   minLines = 3
   setText(stepText(draft?.optJSONArray("source_steps")))
  }

  val publishedSteps = item?.optJSONArray("published_steps")?.takeIf { it.length() > 0 }
  val generatedSteps = draft?.optJSONArray("generated_steps")?.takeIf { it.length() > 0 }
  val reviewCandidate = generatedSteps ?: publishedSteps
  val reviewed = field(
   if (generatedSteps != null) "Generated step suggestions · review/edit before publishing"
   else if (publishedSteps != null) "Current customer pickup instructions · one per line"
   else "Reviewed pickup instructions · one per line"
  ).apply {
   inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
   minLines = 3
   setText(stepText(reviewCandidate))
  }

  val available = CheckBox(this).apply {
   text = "Available after publishing"
   setTextColor(wine)
   isChecked = draft?.optBoolean("active") ?: item?.optBoolean("active") ?: true
  }
  body.addView(available)
  val status = TextView(this).apply {
   textSize = 13f
   setTextColor(Color.rgb(160, 45, 35))
   setPadding(0, 6, 0, 10)
  }
  body.addView(status)

  fun itemPayload(): JSONObject? {
   val nameValue = name.text.toString().trim()
   val kitCents = parseCents(kitPrice.text.toString())
   val regularCents = regularPrice.text.toString().trim().takeIf { it.isNotEmpty() }?.let(::parseCents)
   val preparedCents = preparedTotal.text.toString().trim().takeIf { it.isNotEmpty() }?.let(::parseCents)

   if (nameValue.isEmpty()) {
    status.text = "Enter a meal-kit name."
    return null
   }
   if (kitCents == null) {
    status.text = "Enter a meal-kit price with up to two decimal places."
    return null
   }
   if (regularPrice.text.isNotBlank() && (regularCents == null || regularCents < kitCents)) {
    status.text = "Regular pre-tax menu price must be at least the kit price."
    return null
   }
   if (preparedTotal.text.isNotBlank() && preparedCents == null) {
    status.text = "Enter the prepared-meal total with up to two decimal places."
    return null
   }

   val sourceSteps = stepValues(source.text.toString())
   val reviewedSteps = stepValues(reviewed.text.toString())
   if (!validStepSet(sourceSteps, required = false)) {
    status.text = "Chef notes may contain up to 80 steps, with at most 2,000 characters per step."
    return null
   }
   if (reviewed.text.isNotBlank() && !validStepSet(reviewedSteps, required = true)) {
    status.text = "Reviewed instructions may contain 1–80 steps, with at most 2,000 characters per step."
    return null
   }

   status.text = ""
   return JSONObject()
    .put("p_name", nameValue.take(120))
    .put("p_description", description.text.toString().trim().take(1000))
    .put("p_price_cents", kitCents)
    .put("p_regular_price_cents", regularCents ?: JSONObject.NULL)
    .put("p_prepared_meal_total_cents", preparedCents ?: JSONObject.NULL)
    .put("p_equipment", csvValues(equipment.text.toString()))
    .put("p_allergens", csvValues(allergens.text.toString()))
    .put("p_active", available.isChecked)
    .put("p_source_steps", sourceSteps)
  }

  fun saveRoute(payload: JSONObject): String {
   val route = if (item == null) "/rest/v1/rpc/create_catalog_item_draft" else "/rest/v1/rpc/save_catalog_item_draft"
   if (item != null) payload.put("p_catalog_item_id", item.optString("id"))
   payload.put("p_restaurant_id", rid)
   return route
  }

  button("Save private draft") {
   val payload = itemPayload() ?: return@button
   val route = saveRoute(payload)
   go({ req(route, "POST", payload).let { "saved" } }) {
    Toast.makeText(this, "Private draft saved.", Toast.LENGTH_SHORT).show()
    catalogScreen()
   }
  }

  if (merchantRole == "owner" || merchantRole == "manager") {
   button("Publish reviewed instructions") {
    val reviewedSteps = stepValues(reviewed.text.toString())
    if (!validStepSet(reviewedSteps, required = true)) {
     status.text = "Add 1–80 reviewed steps, each no longer than 2,000 characters."
     return@button
    }

    val payload = itemPayload() ?: return@button
    val route = saveRoute(payload)
    go({
     val saved = JSONArray(req(route, "POST", payload)).getJSONObject(0)
     val publish = JSONObject()
      .put("p_draft_id", saved.getString("prep_draft_id"))
      .put("p_expected_updated_at", saved.getString("draft_updated_at"))
      .put("p_reviewed_steps", reviewedSteps)
     req("/rest/v1/rpc/publish_prep_draft", "POST", publish).let { "published" }
    }) {
     Toast.makeText(this, "Meal kit published with reviewed pickup instructions.", Toast.LENGTH_LONG).show()
     catalogScreen()
    }
   }
  }

  button("Back to meal kits") { catalogScreen() }
 }
 private fun orders(){dashboard()}
 private fun pickupRange(start:String,end:String,timezone:String):String{val zone=runCatching{java.time.ZoneId.of(timezone)}.getOrDefault(java.time.ZoneId.of("America/Los_Angeles"));val day=java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d",java.util.Locale.getDefault()).withZone(zone);val time=java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT).withLocale(java.util.Locale.getDefault()).withZone(zone);return "${day.format(java.time.Instant.parse(start))} · ${time.format(java.time.Instant.parse(start))}–${time.format(java.time.Instant.parse(end))}"}
 private fun ordersInline() {
  go({
   val from = java.time.Instant.now().minus(java.time.Duration.ofDays(30)).toString()
   req("/rest/v1/orders?select=id,status,payment_status,pickup_mode,total_cents,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,items:order_items(name_snapshot,quantity)&restaurant_id=eq.$rid&or=(status.in.(placed,accepted,preparing,ready),pickup_starts_at.gte.$from,payment_status.eq.refunded)&order=pickup_starts_at.asc")
  }) { result ->
   val orders = JSONArray(result)
   if (orders.length() == 0) text("No upcoming pickup orders. New reservations appear here.")

   for (index in 0 until orders.length()) {
    val order = orders.getJSONObject(index)
    val orderId = order.optString("id")
    val orderStatus = order.optString("status")
    val paymentStatus = order.optString("payment_status")
    val refunded = paymentStatus == "refunded"
    val titleText = if (refunded) "Order · REFUNDED" else "Order · ${orderStatus.replace('_', ' ').uppercase(java.util.Locale.ROOT)}"
    title(titleText, 17f)
    if (refunded) text("Refund confirmed by Stripe")

    val start = order.optString("pickup_starts_at")
    val end = order.optString("pickup_ends_at")
    val timezone = order.optString("restaurant_timezone", rtimezone)
    val amountCents = order.optInt("total_cents", order.optInt("subtotal_cents"))
    val vehicle = order.optJSONObject("vehicle")
    val vehicleLabel = if (order.optString("pickup_mode") == "curbside") {
     listOf(vehicle?.optString("color"), vehicle?.optString("make"), vehicle?.optString("model"))
      .filter { !it.isNullOrBlank() && it != "null" }
      .joinToString(" ")
    } else "Counter pickup"
    val pickupText = if (start.isNotBlank() && end.isNotBlank()) pickupRange(start, end, timezone) else "Pickup time unavailable"
    val amountText = String.format(java.util.Locale.ROOT, "$%.2f", amountCents / 100.0)
    text("$pickupText\n${order.optString("pickup_mode")} · $amountText\n$vehicleLabel")

    val lines = order.optJSONArray("items") ?: JSONArray()
    for (lineIndex in 0 until lines.length()) {
     val line = lines.getJSONObject(lineIndex)
     text("${line.optInt("quantity")} × ${line.optString("name_snapshot")}")
    }

    val nextStatus = when (orderStatus) {
     "placed" -> "accepted"
     "accepted" -> "preparing"
     "preparing" -> "ready"
     "ready" -> "completed"
     else -> ""
    }
    if (nextStatus.isNotEmpty()) {
     val actionLabel = if (nextStatus == "completed") "Mark picked up" else "Mark $nextStatus"
     button(actionLabel) {
      go({
       req("/rest/v1/rpc/update_order_status", "POST", JSONObject()
        .put("p_order_id", orderId)
        .put("p_status", nextStatus))
       "updated"
      }) { dashboard() }
     }
    }

    if (orderStatus in listOf("placed", "accepted", "preparing", "ready")) {
     button("Cancel and refund") {
      AlertDialog.Builder(this)
       .setTitle("Cancel and refund order?")
       .setMessage("Cena will request a refund from Stripe. The order will only be treated as refunded when the payment service confirms it.")
       .setNegativeButton("Keep order", null)
       .setPositiveButton("Confirm refund") { _, _ ->
        go({ apiReq("/v1/orders/$orderId/refund", "POST", JSONObject()) }) { response ->
         val result = JSONObject(response).optString("status")
         val message = when (result) {
          "refunded" -> "Order refunded."
          "pending" -> "Refund is processing. Check again shortly."
          "failed" -> "Refund failed. Contact Cena support."
          else -> "Refund status: $result"
         }
         Toast.makeText(this, message, Toast.LENGTH_LONG).show()
         dashboard()
        }
       }
       .show()
     }
    }
   }
  }
 }

}
