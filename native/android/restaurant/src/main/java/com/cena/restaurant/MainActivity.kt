package com.cena.restaurant
import android.app.*;import android.content.Intent;import android.net.Uri;import android.os.*;import android.graphics.Color;import android.graphics.drawable.GradientDrawable;import android.view.*;import android.widget.*;import org.json.*;import java.net.*;import java.util.concurrent.Executors
import com.cena.auth.CenaAndroidAuthSession
import com.cena.auth.CenaSessionExpiredException
import com.cena.auth.CenaSessionRefreshException
import com.cena.auth.CenaSessionStorageException
class MainActivity:Activity(){private val bg=Color.rgb(250,246,243);private val paper=Color.rgb(255,253,250);private val peach=Color.rgb(255,240,232);private val rose=Color.rgb(233,207,196);private val coral=Color.rgb(197,119,96);private val clay=Color.rgb(133,87,74);private val ink=Color.rgb(39,29,25);private val wine=Color.rgb(93,16,10);private val ex=Executors.newSingleThreadExecutor();private val requestGeneration=ThreadLocal<Long>();private val requestRestaurantId=ThreadLocal<String>();private val requestRestaurantRevision=ThreadLocal<Int>();@Volatile private var selectedRestaurantRevision=0;private lateinit var body:LinearLayout;private val authSession by lazy{CenaAndroidAuthSession(applicationContext,BuildConfig.SUPABASE_URL,BuildConfig.SUPABASE_KEY,"merchant",legacyRefreshTokenKey="refresh",legacyAccessTokenKey="token")};private var signInNotice:String?=null;private var showingLogin=false;@Volatile private var rid="";private var rname="";private var rtimezone="America/Los_Angeles";private var merchantRole="staff";private var curb=false;private var awaitingStripeReturn=false;private var insightsDays=30;private var insightsOrders:JSONArray?=null;private var insightsError:String?=null;private var insightsLoading=false;private var insightsTruncated=false;private var insightsRequestVersion=0;private var showingInsights=false;private var restoreInsightsId:String?=null;private var restoreInsightsDays=30
 override fun onCreate(b:Bundle?){super.onCreate(b);window.statusBarColor=bg;window.navigationBarColor=bg;window.decorView.systemUiVisibility=View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;awaitingStripeReturn=isStripeReturn(intent.data);if(b?.getString(STATE_SCREEN)==STATE_INSIGHTS){restoreInsightsId=b.getString(STATE_RESTAURANT_ID);restoreInsightsDays=b.getInt(STATE_INSIGHTS_DAYS,30).takeIf{it==30||it==90}?:30};if(authSession.restore()!=null)loadRestaurants()else login()}
 override fun onSaveInstanceState(outState:Bundle){super.onSaveInstanceState(outState);val selectedId=if(showingInsights)rid else restoreInsightsId;if(!selectedId.isNullOrBlank()){outState.putString(STATE_SCREEN,STATE_INSIGHTS);outState.putString(STATE_RESTAURANT_ID,selectedId);outState.putInt(STATE_INSIGHTS_DAYS,if(showingInsights)insightsDays else restoreInsightsDays)}}
 companion object { private const val STATE_SCREEN="restaurant.screen";private const val STATE_RESTAURANT_ID="restaurant.insights.restaurant_id";private const val STATE_INSIGHTS_DAYS="restaurant.insights.days";private const val STATE_INSIGHTS="insights";private const val ACTIVE_ORDER_PAGE_SIZE=100;private const val RECENT_HISTORY_LIMIT=100;private const val RECENT_PICKUP_DAYS=30 }
 override fun onResume(){super.onResume();if(awaitingStripeReturn&&rid.isNotBlank()){awaitingStripeReturn=false;paymentSetup()}}
 override fun onNewIntent(intent:Intent){super.onNewIntent(intent);setIntent(intent);if(isStripeReturn(intent.data)){awaitingStripeReturn=true;if(rid.isNotBlank()){awaitingStripeReturn=false;paymentSetup()}else if(authSession.restore()!=null)loadRestaurants()}}
 private fun isStripeReturn(uri:Uri?):Boolean=uri?.scheme=="cena-restaurant"&&uri.host=="connect"&&uri.path=="/return"
 private fun base() {
  val sc = ScrollView(this)
  val outer = LinearLayout(this).apply { orientation = 1; gravity = Gravity.CENTER_HORIZONTAL; setBackgroundColor(bg) }
  body = LinearLayout(this).apply {
   orientation = 1
   setPadding(22, 22, 22, 24)
   setBackgroundColor(bg)
   layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
    width = resources.displayMetrics.widthPixels.coerceAtMost((680 * resources.displayMetrics.density).toInt())
   }
  }
  outer.addView(body)
  sc.addView(outer)
  setContentView(sc)
 }
 private fun title(s:String,z:Float=25f) = title(s,z,body)
 private fun title(s:String,z:Float,target:LinearLayout) {
  target.addView(TextView(this).apply {
   text = s
   textSize = z
   setTextColor(wine)
   setPadding(12, 9, 12, 9)
   typeface = android.graphics.Typeface.DEFAULT_BOLD
   background = GradientDrawable().apply {
    setColor(paper)
    cornerRadius = 13 * resources.displayMetrics.density
    setStroke((1 * resources.displayMetrics.density).toInt(), coral)
   }
  })
 }
 private fun text(s:String) = text(s,body)
 private fun text(s:String,target:LinearLayout) {
  target.addView(TextView(this).apply { text = s; textSize = 15f; setTextColor(clay); setPadding(0, 5, 0, 10) })
 }
 private fun button(s:String,f:()->Unit):Button = button(s,body,f)
 private fun button(s:String,target:LinearLayout,f:()->Unit):Button {
  val result = Button(this).apply {
   text = s
   setTextColor(-1)
   background = GradientDrawable().apply {
    setColor(wine)
    cornerRadius = (16f + ((390f - resources.displayMetrics.widthPixels / resources.displayMetrics.density) / 110f * 10f)).coerceIn(16f, 26f) * resources.displayMetrics.density
   }
   setOnClickListener { f() }
  }
  target.addView(result)
  return result
 }
 private fun field(s:String):EditText {
  val field = EditText(this).apply { hint = s }
  body.addView(field)
  return field
 }
 private data class HttpResponse(val status:Int,val body:String)
 private class StaleMerchantScopeException:Exception()
 private fun go(task:()->String,done:(String)->Unit){go(task,done,null)}
 private fun go(task:()->String,done:(String)->Unit,onError:((Exception)->Unit)?){val expectedGeneration=authSession.generationSnapshot();val expectedRestaurantId=rid;val expectedRestaurantRevision=selectedRestaurantRevision;ex.execute{requestGeneration.set(expectedGeneration);requestRestaurantId.set(expectedRestaurantId);requestRestaurantRevision.set(expectedRestaurantRevision);try{if(selectedRestaurantRevision!=expectedRestaurantRevision||rid!=expectedRestaurantId)return@execute;authSession.assertCurrentGeneration(expectedGeneration);val result=task();authSession.assertCurrentGeneration(expectedGeneration);runOnUiThread{if(isFinishing||isDestroyed||selectedRestaurantRevision!=expectedRestaurantRevision||rid!=expectedRestaurantId)return@runOnUiThread;if(authSession.generationSnapshot()==expectedGeneration)done(result)}}catch(error:Exception){if(error is CenaSessionExpiredException)showExpiredSignInIfNeeded()else if(error is StaleMerchantScopeException)Unit else runOnUiThread{if(isFinishing||isDestroyed||selectedRestaurantRevision!=expectedRestaurantRevision||rid!=expectedRestaurantId||authSession.generationSnapshot()!=expectedGeneration)return@runOnUiThread;if(onError!=null)onError(error)else Toast.makeText(this,error.message?:"Request failed",Toast.LENGTH_LONG).show()}}finally{requestGeneration.remove();requestRestaurantId.remove();requestRestaurantRevision.remove()}}}
 private fun rawRequest(baseUrl:String,path:String,method:String,data:JSONObject?,accessToken:String?,includeApiKey:Boolean):HttpResponse{val connection=URL(baseUrl.trimEnd('/')+path).openConnection() as HttpURLConnection;connection.requestMethod=method;connection.connectTimeout=9000;connection.readTimeout=12000;if(includeApiKey)connection.setRequestProperty("apikey",BuildConfig.SUPABASE_KEY);if(accessToken!=null)connection.setRequestProperty("Authorization","Bearer $accessToken");connection.setRequestProperty("Content-Type","application/json");if(data!=null){connection.doOutput=true;connection.outputStream.use{it.write(data.toString().toByteArray())}};val status=connection.responseCode;val stream=if(status<400)connection.inputStream else connection.errorStream;val body=stream?.bufferedReader()?.use{it.readText()}?:"";connection.disconnect();return HttpResponse(status,body)}
 private fun authenticatedRequest(baseUrl:String,path:String,method:String,data:JSONObject?,includeApiKey:Boolean):String{try{assertRequestScope();val session=authSession.restore()?:throw CenaSessionExpiredException();val generation=requestGeneration.get()?:session.generation;if(generation!=session.generation)throw CenaSessionExpiredException();var token=authSession.accessTokenForRequest(generation)?:throw CenaSessionExpiredException();assertRequestScope();var response=rawRequest(baseUrl,path,method,data,token,includeApiKey);if(response.status==401){token=authSession.refreshAfterUnauthorized(token,generation);authSession.assertCurrentGeneration(generation);assertRequestScope();response=rawRequest(baseUrl,path,method,data,token,includeApiKey);if(response.status==401){authSession.signOutIfCurrent(generation);throw CenaSessionExpiredException()}};authSession.assertCurrentGeneration(generation);assertRequestScope();if(response.status>=400)throw java.io.IOException(response.body.ifBlank{"Request failed (${response.status})."});return response.body}catch(error:CenaSessionExpiredException){showExpiredSignInIfNeeded();throw error}}
 private fun req(path:String,method:String="GET",data:JSONObject?=null):String=authenticatedRequest(BuildConfig.SUPABASE_URL,path,method,data,true)
 private fun apiReq(path:String,method:String="GET",data:JSONObject?=null):String=authenticatedRequest(BuildConfig.CENA_API_URL,path,method,data,false)
 private fun assertRequestScope(){val expectedRestaurantId=requestRestaurantId.get()?:return;val expectedRevision=requestRestaurantRevision.get()?:return;if(rid!=expectedRestaurantId||selectedRestaurantRevision!=expectedRevision)throw StaleMerchantScopeException()}
 private fun showExpiredSignInIfNeeded(){val expectedGeneration=authSession.generationSnapshot();if(runCatching{authSession.restore()}.getOrNull()!=null)return;runOnUiThread{if(isFinishing||isDestroyed||showingLogin||authSession.generationSnapshot()!=expectedGeneration||runCatching{authSession.restore()}.getOrNull()!=null)return@runOnUiThread;rid="";rname="";merchantRole="staff";rtimezone="America/Los_Angeles";curb=false;selectedRestaurantRevision++;restoreInsightsId=null;showingInsights=false;signInNotice="Your Cena sign-in expired. Sign in again to continue.";login()}}
 private fun trustedOnboardingUrl(url:String):Boolean{try{val uri=java.net.URI(url);return uri.scheme=="https"&&uri.host.equals("connect.stripe.com",true)&&uri.userInfo==null}catch(_:Exception){return false}}
 private fun paymentSetup(){go({apiReq("/v1/restaurants/$rid/payments")}){val info=JSONObject(it);val status=info.optString("status");base();title("Cena payments");when(status){"ready"->{text("Stripe is connected. New customer orders can be paid in Cena.");val fee=info.optInt("application_fee_cents",0);if(fee>0)text("Cena platform fee · $${"%.2f".format(fee/100.0)} per order.")};"pending"->{text("Stripe setup is in progress.");button("Refresh payment status"){paymentSetup()}};"not_connected"->{text("Connect your restaurant's Stripe account to accept in-app payments.");button("Set up Stripe securely"){go({apiReq("/v1/restaurants/$rid/stripe-onboarding","POST")}){val url=JSONObject(it).optString("url");if(!trustedOnboardingUrl(url)){Toast.makeText(this,"Stripe setup link could not be verified.",Toast.LENGTH_LONG).show()}else try{startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url)))}catch(_:Exception){Toast.makeText(this,"Could not open Stripe setup.",Toast.LENGTH_LONG).show()}}}};else->text("Payment status is unavailable. Try again shortly.")};button("Back to restaurant"){dashboard()}}}
 private fun login(){showingLogin=true;showingInsights=false;base();title("Cena for Restaurants");text("Manage today's reservations and pickup service.");signInNotice?.let{ text(it) };val emailField=field("Staff email");val passwordField=field("Password");passwordField.inputType=129;button("Sign in"){val email=emailField.text.toString().trim();val password=passwordField.text.toString();val expectedGeneration=authSession.generationSnapshot();ex.execute{try{val response=rawRequest(BuildConfig.SUPABASE_URL,"/auth/v1/token?grant_type=password","POST",JSONObject().put("email",email).put("password",password),null,true);if(response.status==401||response.status==400)throw java.io.IOException("Could not sign in. Check your email and password.");if(response.status>=400)throw java.io.IOException("Could not sign in. Try again.");val accepted=authSession.acceptAuthResponse(response.body,expectedGeneration,email);runOnUiThread{if(isFinishing||isDestroyed||authSession.generationSnapshot()!=accepted.generation)return@runOnUiThread;signInNotice=null;restoreInsightsId=null;loadRestaurants()}}catch(error:Exception){runOnUiThread{if(isFinishing||isDestroyed||authSession.generationSnapshot()!=expectedGeneration)return@runOnUiThread;Toast.makeText(this,error.message?:"Could not sign in. Try again.",Toast.LENGTH_LONG).show()}}}};if(BuildConfig.SUPABASE_URL.isBlank())text("Connect Supabase by setting SUPABASE_URL and SUPABASE_KEY in gradle.properties.")}
 private fun selectRestaurant(membership:JSONObject,restaurant:JSONObject){val nextRestaurantId=restaurant.optString("id");if(nextRestaurantId!=rid)selectedRestaurantRevision++;rid=nextRestaurantId;merchantRole=membership.optString("role","staff");rname=restaurant.optString("name");rtimezone=restaurant.optString("timezone","America/Los_Angeles");curb=restaurant.optBoolean("curbside_enabled")}
 private fun loadRestaurants(){go({req("/rest/v1/merchant_memberships?select=role,restaurant:restaurants(id,name,address,curbside_enabled,timezone)")}){val memberships=JSONArray(it);val requestedId=restoreInsightsId;restoreInsightsId=null;if(requestedId!=null){for(i in 0 until memberships.length()){val membership=memberships.optJSONObject(i)?:continue;val restaurant=membership.optJSONObject("restaurant")?:continue;if(restaurant.optString("id")==requestedId){selectRestaurant(membership,restaurant);loadInsights(restoreInsightsDays);return@go}}};showingLogin=false;showingInsights=false;base();title("Your restaurants");if(memberships.length()==0)text("No restaurant membership is connected to this account.");for(i in 0 until memberships.length()){val membership=memberships.getJSONObject(i);val restaurant=membership.optJSONObject("restaurant")?:continue;button("${restaurant.optString("name")}\n${restaurant.optString("address")}"){selectRestaurant(membership,restaurant);dashboard();if(awaitingStripeReturn){awaitingStripeReturn=false;paymentSetup()}}};button("Sign out"){restoreInsightsId=null;try{authSession.signOut();rid="";rname="";merchantRole="staff";rtimezone="America/Los_Angeles";curb=false;selectedRestaurantRevision++;signInNotice=null;login()}catch(error:Exception){Toast.makeText(this,error.message?:"Could not sign out.",Toast.LENGTH_LONG).show()}}}}
 private fun promotionsScreen(){go({req("/rest/v1/rpc/list_restaurant_promotions","POST",JSONObject().put("p_restaurant_id",rid))}){renderPromotions(JSONArray(it))}}
 private fun renderPromotions(promos:JSONArray){base();title("Promo codes");text("Restaurant-funded discounts · no code is active until you enable it.");button("+ Create promo code"){promotionForm(null)};button("Refresh promo codes"){promotionsScreen()};if(promos.length()==0)text("No promotion codes yet.");for(i in 0 until promos.length()){val p=promos.getJSONObject(i);val code=p.optString("code");val active=p.optBoolean("active");val now=java.time.Instant.now();val starts=runCatching{java.time.Instant.parse(p.optString("starts_at"))}.getOrNull();val ends=runCatching{java.time.Instant.parse(p.optString("ends_at"))}.getOrNull();val state=when{!active->"Paused";starts!=null&&starts.isAfter(now)->"Scheduled";ends!=null&&!ends.isAfter(now)->"Ended";else->"Active"};title("$code · ${p.optInt("discount_percent")}% off",18f);text("$state · ${p.optInt("redemption_count")} redeemed${if(p.isNull("max_redemptions"))"" else " / ${p.optInt("max_redemptions")}"} · ${p.optInt("reserved_redemptions")} reserved\nStarts ${p.optString("starts_at").replace("T"," ").take(16)}${if(p.isNull("ends_at"))"" else " · Ends ${p.optString("ends_at").replace("T"," ").take(16)}"}");button(if(active)"Pause $code" else "Enable $code"){go({req("/rest/v1/rpc/save_restaurant_promotion","POST",JSONObject().put("p_restaurant_id",rid).put("p_code",code).put("p_discount_percent",p.optInt("discount_percent")).put("p_starts_at",p.optString("starts_at")).put("p_ends_at",if(p.isNull("ends_at"))JSONObject.NULL else p.optString("ends_at")).put("p_max_redemptions",if(p.isNull("max_redemptions"))JSONObject.NULL else p.optInt("max_redemptions")).put("p_active",!active)).toString()}){promotionsScreen()}};button("Edit $code"){promotionForm(p)}};button("Back to restaurant"){dashboard()}}
 private fun promotionForm(existing:JSONObject?){base();title(if(existing==null)"New promo code" else "Edit promo code");val pattern=java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");val zone=runCatching{java.time.ZoneId.of(rtimezone)}.getOrDefault(java.time.ZoneId.of("America/Los_Angeles"));val code=field("Code (3–32 letters, digits, _ or -)");code.setText(existing?.optString("code")?:"");code.isEnabled=existing==null;code.isSingleLine=true;code.filters=arrayOf(android.text.InputFilter.LengthFilter(32));code.inputType=android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;val percent=field("Discount percent (1–90)");percent.inputType=android.text.InputType.TYPE_CLASS_NUMBER;percent.setText(existing?.optInt("discount_percent")?.toString()?:"10");fun local(value:String?):String{if(value.isNullOrBlank())return "";return runCatching{java.time.LocalDateTime.ofInstant(java.time.Instant.parse(value),zone).format(pattern)}.getOrDefault("")};val starts=field("Starts · local time YYYY-MM-DD HH:mm");starts.setText(local(existing?.optString("starts_at")?.takeIf{it!="null"}).ifBlank{java.time.LocalDateTime.now(zone).plusMinutes(5).withSecond(0).withNano(0).format(pattern)});val ends=field("Ends · optional local time YYYY-MM-DD HH:mm");ends.setText(local(existing?.optString("ends_at")?.takeIf{it!="null"}));val max=field("Maximum redemptions · optional");max.inputType=android.text.InputType.TYPE_CLASS_NUMBER;max.setText(existing?.optInt("max_redemptions")?.takeIf{it>0}?.toString()?:"");val enabled=CheckBox(this).apply{text="Enable code";setTextColor(wine);isChecked=existing?.optBoolean("active")?:false};body.addView(enabled);val error=TextView(this).apply{setTextColor(Color.rgb(160,45,35));textSize=13f};body.addView(error);button(if(existing==null)"Save promo code" else "Save changes"){val normalized=code.text.toString().trim().uppercase(java.util.Locale.ROOT);val pct=percent.text.toString().toIntOrNull();val maxCount=max.text.toString().trim().takeIf{it.isNotEmpty()}?.toIntOrNull();val parsedStart=runCatching{java.time.LocalDateTime.parse(starts.text.toString().trim(),pattern)}.getOrNull();val parsedEnd=ends.text.toString().trim().takeIf{it.isNotEmpty()}?.let{runCatching{java.time.LocalDateTime.parse(it,pattern)}.getOrNull()};when{!normalized.matches(Regex("^[A-Z0-9][A-Z0-9_-]{2,31}$"))->error.text="Enter a 3–32 character code using letters, digits, hyphens, or underscores.";pct==null||pct !in 1..90->error.text="Discount must be between 1 and 90 percent.";parsedStart==null->error.text="Enter a start time as YYYY-MM-DD HH:mm.";ends.text.isNotBlank()&&parsedEnd==null->error.text="Enter an end time as YYYY-MM-DD HH:mm.";parsedEnd!=null&&!parsedEnd.isAfter(parsedStart)->error.text="End time must be after start time.";max.text.isNotBlank()&&(maxCount==null||maxCount<1)->error.text="Maximum redemptions must be a positive number.";else->{val startsIso=parsedStart.atZone(zone).toInstant().toString();val endsIso=parsedEnd?.atZone(zone)?.toInstant()?.toString();val payload=JSONObject().put("p_restaurant_id",rid).put("p_code",normalized).put("p_discount_percent",pct).put("p_starts_at",startsIso).put("p_ends_at",endsIso?:JSONObject.NULL).put("p_max_redemptions",maxCount?:JSONObject.NULL).put("p_active",enabled.isChecked);go({req("/rest/v1/rpc/save_restaurant_promotion","POST",payload).let{"saved"}}){promotionsScreen()}}}};button("Back to promo codes"){promotionsScreen()}} private fun dashboard(){showingLogin=false;showingInsights=false;base();title(rname);text("Today's pickup operations");button(if(curb)"Curbside pickup: ON" else "Curbside pickup: OFF"){go({req("/rest/v1/restaurants?id=eq.$rid","PATCH",JSONObject().put("curbside_enabled",!curb));"ok"}){curb=!curb;dashboard()}};button("Refresh orders"){orders()};button("Payment setup"){paymentSetup()};button("Manage meal kits"){catalogScreen()};button("Insights"){loadInsights()};if(merchantRole=="owner"||merchantRole=="manager")button("Manage promo codes"){promotionsScreen()};ordersInline()}
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

 private fun sameSteps(left: JSONArray?, right: JSONArray?): Boolean {
  if (left == null || right == null || left.length() != right.length()) return false
  return (0 until left.length()).all { index -> left.optString(index) == right.optString(index) }
 }

 private fun prepGenerationFailure(error: Exception): String {
  if (error is CenaSessionExpiredException || error is CenaSessionRefreshException || error is CenaSessionStorageException) {
   return error.message ?: "Sign in again to continue."
  }
  val code = runCatching { JSONObject(error.message.orEmpty()).optString("error") }.getOrDefault("")
  return when (code) {
   "invalid_recipe_steps" -> "Add 1–80 private chef notes, no longer than 2,000 characters each, before requesting suggestions."
   "draft_not_found", "item_not_found" -> "Save the private chef notes and try again. You can also write pickup instructions manually."
   "recipe_changed_retry" -> "The recipe changed during generation. Refresh this meal kit before trying again."
   else -> "Private suggestions are unavailable right now. Your notes remain in this form; save them if needed, then continue editing pickup steps manually."
  }
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

  var generatingSuggestions = false
  // A new form becomes an existing draft as soon as its first private save succeeds.
  // Retain that identity for retries, later saves, and explicit publication.
  var currentCatalogItemId = item?.optString("id")?.takeIf { it.isNotBlank() && it != "null" }

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
   val route = if (currentCatalogItemId == null) "/rest/v1/rpc/create_catalog_item_draft" else "/rest/v1/rpc/save_catalog_item_draft"
   currentCatalogItemId?.let { payload.put("p_catalog_item_id", it) }
   payload.put("p_restaurant_id", rid)
   return route
  }

  button("Save private draft") {
   if (generatingSuggestions) return@button
   val payload = itemPayload() ?: return@button
   val route = saveRoute(payload)
   go({ req(route, "POST", payload).let { "saved" } }) {
    Toast.makeText(this, "Private draft saved.", Toast.LENGTH_SHORT).show()
    catalogScreen()
   }
  }

  if (merchantRole == "owner" || merchantRole == "manager") {
   button("Publish reviewed instructions") {
    if (generatingSuggestions) return@button
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

  if (merchantRole == "owner" || merchantRole == "manager") {
   text("AI suggestions use only your saved private chef notes. They stay private until reviewed and published.")
   val generateButton = Button(this).apply {
    text = "Generate private step suggestions"
    setTextColor(Color.WHITE)
    contentDescription = text
    background = GradientDrawable().apply {
     setColor(wine)
     cornerRadius = (16f + ((390f - resources.displayMetrics.widthPixels / resources.displayMetrics.density) / 110f * 10f)).coerceIn(16f, 26f) * resources.displayMetrics.density
    }
   }
   body.addView(generateButton, LinearLayout.LayoutParams(-1, -2))
   val actionButtons = (0 until body.childCount).mapNotNull { body.getChildAt(it) as? Button }
   val formFields = listOf(name, description, kitPrice, regularPrice, preparedTotal, equipment, allergens, source, reviewed)
   fun setGenerating(isGenerating: Boolean) {
    generatingSuggestions = isGenerating
    formFields.forEach { it.isEnabled = !isGenerating }
    actionButtons.forEach { it.isEnabled = !isGenerating }
    generateButton.text = if (isGenerating) "Generating private suggestions…" else "Generate private step suggestions"
    generateButton.contentDescription = generateButton.text
   }

   generateButton.setOnClickListener {
    val sourceSnapshot = stepValues(source.text.toString())
    val sourceCharacters = (0 until sourceSnapshot.length()).sumOf { sourceSnapshot.optString(it).length }
    if (!validStepSet(sourceSnapshot, required = true) || sourceCharacters > 12_000) {
     status.text = "Add 1–80 chef notes (up to 2,000 characters each and 12,000 total) before requesting suggestions. You can still write reviewed steps manually."
     return@setOnClickListener
    }
    val payload = itemPayload() ?: return@setOnClickListener
    val route = saveRoute(payload)
    val targetRestaurantId = rid
    val targetRestaurantRevision = selectedRestaurantRevision
    val existingItemId = currentCatalogItemId.orEmpty()
    status.setTextColor(clay)
    status.text = "Saving private chef notes, then requesting suggestions…"
    setGenerating(true)

    go(task = {
     assertRequestScope()
     val savedRows = JSONArray(req(route, "POST", payload))
     if (savedRows.length() != 1) throw java.io.IOException("Could not save the private recipe draft.")
     val saved = savedRows.getJSONObject(0)
     val savedItemId = saved.optString("catalog_item_id")
     if (savedItemId.isBlank() || (existingItemId.isNotBlank() && existingItemId != savedItemId)) {
      throw java.io.IOException("The meal kit changed while this form was open. Refresh and try again.")
     }
     if (rid != targetRestaurantId || selectedRestaurantRevision != targetRestaurantRevision) throw StaleMerchantScopeException()
     savedItemId
    }, done = { savedItemId ->
     currentCatalogItemId = savedItemId
     // Generation is a separate request so a failed AI call still leaves this form
     // attached to the already-saved private item instead of creating a duplicate.
     go(task = {
      assertRequestScope()
     // The Edge Function reads the authenticated user's saved draft; send the item id only.
     val generated = JSONObject(req(
      "/functions/v1/generate-prep",
      "POST",
      JSONObject().put("item_id", savedItemId)
     ))
     val returnedSteps = generated.optJSONArray("generated_steps")
     val updatedAt = generated.optString("updated_at")
     if (generated.optString("status") != "private_draft" || generated.optString("item_id") != savedItemId ||
      updatedAt.isBlank() || !validStepSet(returnedSteps ?: JSONArray(), required = true) ||
      returnedSteps?.length() != sourceSnapshot.length()) {
      throw java.io.IOException("The private suggestion response could not be verified.")
     }
     if (rid != targetRestaurantId || selectedRestaurantRevision != targetRestaurantRevision) throw StaleMerchantScopeException()

     val latestRows = JSONArray(req(
      "/rest/v1/prep_drafts?select=id,restaurant_id,catalog_item_id,source_steps,generated_steps,updated_at" +
       "&restaurant_id=eq.$targetRestaurantId&catalog_item_id=eq.$savedItemId&limit=1"
     ))
     val latest = latestRows.optJSONObject(0)
     val latestSource = latest?.optJSONArray("source_steps")
     val latestGenerated = latest?.optJSONArray("generated_steps")
     if (latestRows.length() != 1 || latest == null || latest.optString("restaurant_id") != targetRestaurantId ||
      latest.optString("catalog_item_id") != savedItemId || latest.optString("updated_at") != updatedAt ||
      !sameSteps(latestSource, sourceSnapshot) || !sameSteps(latestGenerated, returnedSteps)) {
      throw java.io.IOException("recipe_changed_retry")
     }
      JSONObject().put("generated_steps", returnedSteps).toString()
     }, done = { response ->
      setGenerating(false)
      val result = JSONObject(response)
      reviewed.setText(stepText(result.getJSONArray("generated_steps")))
     reviewed.hint = "Generated private suggestions · review/edit before publishing"
     status.setTextColor(clay)
     status.text = "Private suggestions saved. Review every step and edit them before publishing."
     }, onError = { error ->
      setGenerating(false)
      status.setTextColor(Color.rgb(160, 45, 35))
      status.text = prepGenerationFailure(error)
     })
    }, onError = { error ->
     setGenerating(false)
     status.setTextColor(Color.rgb(160, 45, 35))
     status.text = error.message ?: "Could not save the private recipe draft."
    })
   }
  }

  button("Back to meal kits") { catalogScreen() }
 }
 private data class MerchantInsights(
  val orderCount: Int,
  val completedCount: Int,
  val completedKits: Int,
  val stripeGrossCents: Long,
  val refundedStripeCents: Long,
  val completedPayAtPickupOrders: Int
) {
  val netStripeCents: Long get() = stripeGrossCents - refundedStripeCents
 }

 private fun loadInsights(days: Int = insightsDays) {
  insightsDays = days
  val requestVersion = ++insightsRequestVersion
  insightsOrders = null
  insightsError = null
  insightsTruncated = false
  insightsLoading = true
  renderInsights()

  go({
   try {
   val createdAfter = java.time.Instant.now().minus(java.time.Duration.ofDays(days.toLong())).toString()
   val orders = JSONArray()
   val pageSize = 500
   var offset = 0
   var truncated = false
   while (offset < 10_000) {
    val path = "/rest/v1/orders?select=id,status,payment_method,payment_status,total_cents,subtotal_cents,created_at,items:order_items(quantity)" +
     "&restaurant_id=eq.$rid&created_at=gte.$createdAfter&order=created_at.desc,id.desc&limit=$pageSize&offset=$offset"
    val page = JSONArray(req(path))
    for (index in 0 until page.length()) orders.put(page.getJSONObject(index))
    if (page.length() < pageSize) break
    offset += pageSize
    if (offset >= 10_000) truncated = true
   }
   JSONObject().put("orders", orders).put("truncated", truncated).toString()
   } catch (error: Exception) {
    JSONObject().put("error", error.message ?: "Could not load orders.").toString()
   }
  }) { response ->
   if (requestVersion != insightsRequestVersion || days != insightsDays) return@go
   val result = JSONObject(response)
   if (result.has("error")) {
    insightsError = "Could not load insights. Check your connection and try again."
    insightsLoading = false
    renderInsights()
    return@go
   }
   insightsOrders = result.getJSONArray("orders")
   insightsTruncated = result.optBoolean("truncated")
   insightsError = null
   insightsLoading = false
   renderInsights()
  }
 }

 private fun renderInsights() {
  showingLogin = false
  showingInsights = true
  base()
  title("Restaurant insights")
  text("Review confirmed pickup activity and Stripe payments for this location.")

  val periods = LinearLayout(this).apply {
   orientation = LinearLayout.HORIZONTAL
   gravity = android.view.Gravity.CENTER
   setPadding(0, 4, 0, 8)
  }
  for (days in listOf(30, 90)) {
   val selected = days == insightsDays
   val periodButton = Button(this).apply {
    text = "Past $days days"
    contentDescription = "Past $days days${if (selected) ", selected" else ""}"
    isSelected = selected
    setTextColor(if (selected) Color.WHITE else wine)
    backgroundTintList = android.content.res.ColorStateList.valueOf(if (selected) wine else rose)
    setOnClickListener { if (days != insightsDays) loadInsights(days) }
   }
   val params = LinearLayout.LayoutParams(0, -2, 1f)
   params.marginEnd = (6 * resources.displayMetrics.density).toInt()
   periods.addView(periodButton, params)
  }
  body.addView(periods)
  text("Orders are grouped by creation date. Stripe totals include confirmed payments and full refunds; they are not a payout or settlement report.")

  if (insightsLoading && insightsOrders == null) {
   text("Loading order insights…")
  } else if (insightsError != null && insightsOrders == null) {
   title("Insights unavailable", 18f)
   text(insightsError ?: "Could not load orders.")
   button("Retry insights") { loadInsights() }
  } else if (insightsOrders != null) {
   val summary = summarizeInsights(insightsOrders!!)
   val hasActivity = summary.orderCount > 0 || summary.stripeGrossCents > 0 || summary.refundedStripeCents > 0
   if (!hasActivity) {
    title("No orders in this period", 18f)
    text("Completed pickups and confirmed Stripe payments will appear here when this location has order history.")
   } else {
    insightsMetric("Orders placed", summary.orderCount.toString(), "Confirmed orders")
    insightsMetric("Completed pickups", summary.completedCount.toString(), "Marked completed")
    insightsMetric("Kits in completed orders", summary.completedKits.toString(), "Quantity from completed order items")
    insightsMetric("Stripe payments · gross", formatInsightsCurrency(summary.stripeGrossCents), "Paid orders, including orders later refunded")
    insightsMetric("Stripe refunded", formatInsightsCurrency(summary.refundedStripeCents), "Full Stripe refunds confirmed")
    insightsMetric("Net Stripe payments", formatInsightsCurrency(summary.netStripeCents), "Confirmed Stripe totals minus confirmed refunds")
    if (summary.completedPayAtPickupOrders > 0) {
     text("${summary.completedPayAtPickupOrders} completed pay-at-pickup orders are excluded from Stripe totals. Cena does not record whether those payments were collected.")
    }
   }
   if (insightsTruncated) {
    text("This report reached its 10,000-order limit. Earlier records in this period may be omitted.")
   }
   if (insightsError != null) text("Refresh failed: ${insightsError}")
   button("Refresh insights") { loadInsights() }
  }
  button("Back to restaurant") { dashboard() }
 }

 private fun insightsMetric(label: String, value: String, detail: String) {
  val card = LinearLayout(this).apply {
   orientation = LinearLayout.VERTICAL
   setPadding((16 * resources.displayMetrics.density).toInt(), (12 * resources.displayMetrics.density).toInt(), (16 * resources.displayMetrics.density).toInt(), (12 * resources.displayMetrics.density).toInt())
   background = GradientDrawable().apply {
    setColor(paper)
    cornerRadius = 16 * resources.displayMetrics.density
    setStroke((1 * resources.displayMetrics.density).toInt(), rose)
   }
   isFocusable = true
   contentDescription = "$label: $value. $detail"
  }
  card.addView(TextView(this).apply {
   text = label
   textSize = 13f
   setTextColor(clay)
  })
  card.addView(TextView(this).apply {
   text = value
   textSize = 24f
   setTextColor(ink)
   typeface = android.graphics.Typeface.DEFAULT_BOLD
   setPadding(0, 3, 0, 2)
  })
  card.addView(TextView(this).apply {
   text = detail
   textSize = 12f
   setTextColor(clay)
  })
  body.addView(card, LinearLayout.LayoutParams(-1, -2).apply {
   bottomMargin = (10 * resources.displayMetrics.density).toInt()
  })
 }

 private fun formatInsightsCurrency(cents: Long): String =
  String.format(java.util.Locale.ROOT, "$%.2f", cents / 100.0)

 private fun summarizeInsights(orders: JSONArray): MerchantInsights {
  var confirmedOrders = 0
  var completedOrders = 0
  var completedKits = 0
  var stripeGrossCents = 0L
  var refundedStripeCents = 0L
  var completedPayAtPickupOrders = 0

  for (index in 0 until orders.length()) {
   val order = orders.optJSONObject(index) ?: continue
   val status = order.optString("status").lowercase(java.util.Locale.ROOT)
   val paymentMethod = order.optString("payment_method").lowercase(java.util.Locale.ROOT)
   val paymentStatus = order.optString("payment_status").lowercase(java.util.Locale.ROOT)
   val amountCents = order.optInt("total_cents", order.optInt("subtotal_cents")).coerceAtLeast(0)

   if (status !in listOf("pending_payment", "cancelled") &&
    paymentStatus !in listOf("pending", "expired", "failed", "cancelled")) {
    confirmedOrders++
   }

   if (status == "completed") {
    completedOrders++
    if (paymentMethod == "pay_at_pickup") completedPayAtPickupOrders++
    val items = order.optJSONArray("items") ?: JSONArray()
    for (itemIndex in 0 until items.length()) {
     completedKits += items.optJSONObject(itemIndex)?.optInt("quantity")?.coerceAtLeast(0) ?: 0
    }
   }

   if (paymentMethod == "stripe_checkout") {
    when (paymentStatus) {
     "paid" -> stripeGrossCents += amountCents
     "refunded" -> {
      stripeGrossCents += amountCents
      refundedStripeCents += amountCents
     }
    }
   }
  }

  return MerchantInsights(
   confirmedOrders,
   completedOrders,
   completedKits,
   stripeGrossCents,
   refundedStripeCents,
   completedPayAtPickupOrders
  )
 }

 private fun orders(){dashboard()}
 private fun pickupRange(start:String,end:String,timezone:String):String{val zone=runCatching{java.time.ZoneId.of(timezone)}.getOrDefault(java.time.ZoneId.of("America/Los_Angeles"));val day=java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d",java.util.Locale.getDefault()).withZone(zone);val time=java.time.format.DateTimeFormatter.ofLocalizedTime(java.time.format.FormatStyle.SHORT).withLocale(java.util.Locale.getDefault()).withZone(zone);return "${day.format(java.time.Instant.parse(start))} · ${time.format(java.time.Instant.parse(start))}–${time.format(java.time.Instant.parse(end))}"}
 private fun activeOrdersPath(offset:Int):String = "/rest/v1/orders?select=id,status,payment_status,pickup_mode,total_cents,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,items:order_items(name_snapshot,quantity)&restaurant_id=eq.$rid&status=in.(placed,accepted,preparing,ready)&order=pickup_starts_at.asc,id.asc&limit=$ACTIVE_ORDER_PAGE_SIZE&offset=$offset"

 private fun ordersInline() {
  go({
   val cutoff = java.time.Instant.now().minus(java.time.Duration.ofDays(RECENT_PICKUP_DAYS.toLong())).toString()
   val active = JSONArray(req(activeOrdersPath(0)))
   // Recent history is separate and bounded so old refunds/history can never crowd out active work.
   // A refund with a pickup time uses that 30-day pickup window; only refunds missing pickup time
   // fall back to order creation time.
   var historyUnavailable = false
   val history = try {
    JSONArray(req("/rest/v1/orders?select=id,status,payment_status,pickup_mode,total_cents,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,items:order_items(name_snapshot,quantity)&restaurant_id=eq.$rid&status=not.in.(placed,accepted,preparing,ready)&or=(pickup_starts_at.gte.$cutoff,and(payment_status.eq.refunded,pickup_starts_at.is.null,created_at.gte.$cutoff))&order=pickup_starts_at.desc.nullslast,created_at.desc&limit=$RECENT_HISTORY_LIMIT"))
   } catch (error: Exception) {
    if (error is CenaSessionExpiredException) throw error
    historyUnavailable = true
    JSONArray()
   }
   JSONObject().put("active", active).put("history", history).put("history_unavailable", historyUnavailable).toString()
  }) { result ->
   val data = JSONObject(result)
   val active = data.getJSONArray("active")
   val history = data.getJSONArray("history")
   val seenActiveOrderIds = hashSetOf<String>()
   val activeContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
   body.addView(activeContainer)
   if (active.length() == 0 && history.length() == 0) text("No upcoming pickup orders. New reservations appear here.")
   for (index in 0 until active.length()) {
    val order = active.getJSONObject(index)
    val id = order.optString("id")
    if (id.isBlank() || seenActiveOrderIds.add(id)) renderOrderCard(order, activeContainer)
   }
   if (history.length() > 0) {
    title("Recent pickup history", 17f)
    text("Last $RECENT_PICKUP_DAYS days by pickup time. Refunds without a pickup time use order creation date. Showing up to $RECENT_HISTORY_LIMIT orders.")
    val historyContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    body.addView(historyContainer)
    for (index in 0 until history.length()) renderOrderCard(history.getJSONObject(index), historyContainer)
   }
   if (data.optBoolean("history_unavailable")) {
    text("Recent pickup history is unavailable right now. Active pickup orders are still shown.")
    button("Retry recent history") { dashboard() }
   }
   if (active.length() == ACTIVE_ORDER_PAGE_SIZE) {
    var offset = active.length()
    lateinit var moreButton: Button
    moreButton = button("Load more active orders", activeContainer) {
     if (!moreButton.isEnabled) return@button
     moreButton.isEnabled = false
     moreButton.text = "Loading active orders…"
     go(
      { req(activeOrdersPath(offset)) },
      { pageText ->
       val page = JSONArray(pageText)
       if (page.length() == 0) {
        body.removeView(moreButton)
       } else {
        for (index in 0 until page.length()) {
         val order = page.getJSONObject(index)
         val id = order.optString("id")
         if (id.isBlank() || seenActiveOrderIds.add(id)) renderOrderCard(order, activeContainer)
        }
        offset += page.length()
        if (page.length() < ACTIVE_ORDER_PAGE_SIZE) body.removeView(moreButton)
        else {
         moreButton.isEnabled = true
         moreButton.text = "Load more active orders"
        }
       }
      },
      { error ->
       moreButton.isEnabled = true
       moreButton.text = "Load more active orders"
       Toast.makeText(this, error.message ?: "Could not load more active orders.", Toast.LENGTH_LONG).show()
      },
     )
    }
   }
  }
 }

 private fun renderOrderCard(order: JSONObject,target:LinearLayout=body) {
    val orderId = order.optString("id")
    val orderStatus = order.optString("status")
    val paymentStatus = order.optString("payment_status")
    val refunded = paymentStatus == "refunded"
    val titleText = if (refunded) "Order · REFUNDED" else "Order · ${orderStatus.replace('_', ' ').uppercase(java.util.Locale.ROOT)}"
    title(titleText, 17f, target)
    if (refunded) text("Refund confirmed by Stripe", target)

    val start = order.optString("pickup_starts_at").takeUnless { it == "null" }.orEmpty()
    val end = order.optString("pickup_ends_at").takeUnless { it == "null" }.orEmpty()
    val timezone = order.optString("restaurant_timezone", rtimezone)
    val amountCents = order.optInt("total_cents", order.optInt("subtotal_cents"))
    val vehicle = order.optJSONObject("vehicle")
    val vehicleLabel = if (order.optString("pickup_mode") == "curbside") {
     listOf(vehicle?.optString("color"), vehicle?.optString("make"), vehicle?.optString("model"))
      .filter { !it.isNullOrBlank() && it != "null" }
      .joinToString(" ")
    } else "Counter pickup"
    val pickupText = if (start.isNotBlank() && end.isNotBlank()) {
     runCatching { pickupRange(start, end, timezone) }.getOrDefault("Pickup time unavailable")
    } else "Pickup time unavailable"
    val amountText = String.format(java.util.Locale.ROOT, "$%.2f", amountCents / 100.0)
    text("$pickupText\n${order.optString("pickup_mode")} · $amountText\n$vehicleLabel", target)

    val lines = order.optJSONArray("items") ?: JSONArray()
    for (lineIndex in 0 until lines.length()) {
     val line = lines.getJSONObject(lineIndex)
     text("${line.optInt("quantity")} × ${line.optString("name_snapshot")}", target)
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
     button(actionLabel, target) {
      go({
       req("/rest/v1/rpc/update_order_status", "POST", JSONObject()
        .put("p_order_id", orderId)
        .put("p_status", nextStatus))
       "updated"
      }) { dashboard() }
     }
    }

    if (orderStatus in listOf("placed", "accepted", "preparing", "ready")) {
     button("Cancel and refund", target) {
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
