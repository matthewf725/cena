package com.cena.restaurant

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

fun interface PickupTaskLauncher {
    fun launch(task: () -> String, onSuccess: (String) -> Unit, onFailure: (Exception) -> Unit)
}

/** Native merchant pickup-window and per-item inventory editor. All network work is delegated
 * to MainActivity's authenticated, generation- and restaurant-scoped request executor. */
class MerchantPickupManager(
    private val activity: Activity,
    private val restaurantId: String,
    private val restaurantName: String,
    timezone: String,
    private val isCurrentScope: () -> Boolean,
    private val request: (path: String, method: String, body: JSONObject?) -> String,
    private val launcher: PickupTaskLauncher,
    private val onBack: () -> Unit,
) {
    private val zone = runCatching { ZoneId.of(timezone) }.getOrDefault(ZoneId.of("America/Los_Angeles"))
    private val localFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm", Locale.ROOT)
    private val dateFormat = DateTimeFormatter.ofPattern("EEE, MMM d · h:mm a", Locale.getDefault())
    private val wine = Color.rgb(93, 16, 10)
    private val paper = Color.rgb(255, 253, 250)
    private val ivory = Color.rgb(250, 246, 243)
    private val clay = Color.rgb(133, 87, 74)
    private val coral = Color.rgb(197, 119, 96)
    private val rose = Color.rgb(233, 207, 196)
    private var loadedSlots = JSONArray()
    private var loadedItems = JSONArray()
    private var creatingSlot = false
    private var savingInventorySlot: String? = null
    @Volatile private var screenActive = true

    fun show() {
        screenActive = true
        renderLoading()
        launcher.launch(
            { loadData().toString() },
            { if (isScreenCurrent()) renderList(JSONObject(it)) },
            { error -> if (isScreenCurrent()) renderLoadError(error) },
        )
    }

    private fun loadData(): JSONObject {
        assertScope()
        val items = JSONArray(request(
            "/rest/v1/catalog_items?select=id,name,active,published_at&restaurant_id=eq.$restaurantId&order=name.asc",
            "GET",
            null,
        ))
        val slots = fetchSlots()
        return JSONObject().put("items", items).put("slots", slots)
    }

    private fun fetchSlots(): JSONArray {
        assertScope()
        val now = Instant.now().toString()
        return JSONArray(request(
            "/rest/v1/pickup_slots?select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,active,slot_item_inventory(slot_id,item_id,available_qty,reserved_qty)&restaurant_id=eq.$restaurantId&ends_at=gt.$now&order=starts_at.asc",
            "GET",
            null,
        ))
    }

    private fun assertScope() {
        if (!isCurrentScope()) throw IllegalStateException("Restaurant selection changed. Reopen pickup windows and try again.")
    }

    private fun isScreenCurrent(): Boolean = screenActive && isCurrentScope() && !activity.isFinishing && !activity.isDestroyed

    private fun leaveScreen() {
        screenActive = false
        onBack()
    }

    private fun renderLoading() {
        val content = newPage("Pickup windows & inventory")
        addText(content, "Loading future pickup windows…")
        addButton(content, "Back to restaurant") { leaveScreen() }
        showPage(content)
    }

    private fun renderLoadError(error: Exception) {
        val content = newPage("Pickup windows & inventory")
        addText(content, "Could not load pickup windows: ${error.message ?: "Check the connection and try again."}")
        addButton(content, "Retry") { show() }
        addButton(content, "Back to restaurant") { leaveScreen() }
        showPage(content)
    }

    private fun renderList(data: JSONObject, notice: String? = null, noticeIsError: Boolean = false) {
        loadedItems = data.optJSONArray("items") ?: JSONArray()
        loadedSlots = data.optJSONArray("slots") ?: JSONArray()
        val content = newPage("Pickup windows & inventory")
        addText(content, restaurantName)
        addText(content, "Times use ${zone.id}. New windows are immediately available to guests until the order cutoff. Each selected meal kit starts with 8 available portions.")
        notice?.let { addNotice(content, it, error = noticeIsError) }
        addButton(content, if (creatingSlot) "Creating pickup window…" else "Create pickup window") { renderCreateForm() }
        addButton(content, "Refresh windows & inventory") { show() }
        if (loadedSlots.length() == 0) {
            addText(content, "No future pickup windows. Create one to start accepting same-day meal-kit orders.")
        }
        for (index in 0 until loadedSlots.length()) {
            val slot = loadedSlots.optJSONObject(index) ?: continue
            renderSlotCard(content, slot)
        }
        addButton(content, "Back to restaurant") { leaveScreen() }
        showPage(content)
    }

    private fun renderSlotCard(parent: LinearLayout, slot: JSONObject) {
        val slotId = slot.nonBlank("id") ?: return
        val card = newCard()
        val start = slot.nonBlank("starts_at")
        val end = slot.nonBlank("ends_at")
        val range = if (start != null && end != null) {
            "${formatInstant(start)} – ${formatInstantTime(end)}"
        } else "Pickup time unavailable"
        addTitle(card, range, 18f)
        addText(card, "${slot.optInt("reserved_count")} of ${slot.optInt("capacity")} orders reserved${if (slot.optBoolean("active")) " · Available to guests" else " · Paused"}")
        slot.nonBlank("cutoff_at")?.let { addText(card, "Order cutoff · ${formatInstant(it)}") }

        val rows = slot.optJSONArray("slot_item_inventory") ?: JSONArray()
        val inventoryByItem = linkedMapOf<String, JSONObject>()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            row.nonBlank("item_id")?.let { inventoryByItem[it] = row }
        }
        val itemsById = linkedMapOf<String, JSONObject>()
        for (index in 0 until loadedItems.length()) {
            val item = loadedItems.optJSONObject(index) ?: continue
            item.nonBlank("id")?.let { itemsById[it] = item }
        }
        val itemIds = linkedSetOf<String>().apply {
            addAll(inventoryByItem.keys)
            for ((itemId, item) in itemsById) if (isOrderable(item)) add(itemId)
        }
        if (itemIds.isEmpty()) addText(card, "No meal kits are stocked for this window yet.")
        val inputs = linkedMapOf<String, StockInput>()
        for (itemId in itemIds) {
            val row = inventoryByItem[itemId]
            val item = itemsById[itemId]
            val name = item?.nonBlank("name") ?: "Unavailable meal kit"
            val available = row?.optInt("available_qty", 0) ?: 0
            val reserved = row?.optInt("reserved_qty", 0) ?: 0
            addText(card, "$name · $reserved reserved${if (item == null || !isOrderable(item)) " · Not currently orderable" else ""}")
            val input = EditText(activity).apply {
                hint = "Available portions"
                setText(available.toString())
                inputType = InputType.TYPE_CLASS_NUMBER
                contentDescription = "Available portions for $name"
                setSingleLine(true)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = outline(rose, paper, 10f)
            }
            card.addView(input, matchWrap())
            inputs[itemId] = StockInput(name, available, reserved, row != null, input)
        }

        var saving = false
        lateinit var saveButton: Button
        val feedback = TextView(activity).apply {
            textSize = 13f
            setTextColor(coral)
            setPadding(0, dp(5), 0, dp(5))
        }
        card.addView(feedback, matchWrap())
        saveButton = addButtonEnabled(
            card,
            if (savingInventorySlot == slotId) "Saving inventory…" else "Save inventory",
            savingInventorySlot == null,
        ) {
            if (saving || savingInventorySlot != null) return@addButtonEnabled
            val changes = mutableListOf<InventoryChange>()
            for ((itemId, input) in inputs) {
                val requested = input.field.text.toString().trim().toIntOrNull()
                if (requested == null || requested < 0) {
                    feedback.text = "Enter a whole, non-negative quantity for ${input.name}."
                    return@addButtonEnabled
                }
                if (requested < input.reserved) {
                    feedback.text = "${input.name} already has ${input.reserved} reserved. Set available portions to at least that amount."
                    return@addButtonEnabled
                }
                if (requested != input.available || !input.exists && requested > 0) {
                    changes.add(InventoryChange(itemId, input.name, requested, input.reserved, input.exists))
                }
            }
            if (changes.isEmpty()) {
                feedback.setTextColor(clay)
                feedback.text = "There are no inventory changes to save."
                return@addButtonEnabled
            }
            saving = true
            savingInventorySlot = slotId
            saveButton.isEnabled = false
            saveButton.text = "Saving inventory…"
            feedback.text = ""
            launcher.launch(
                {
                    var failure: String? = null
                    for (change in changes) {
                        try {
                            saveInventoryChange(slotId, change)
                        } catch (error: Exception) {
                            failure = error.message ?: "Inventory save failed."
                            break
                        }
                    }
                    val refreshed = loadData()
                    refreshed.put("notice", if (failure == null) "Inventory saved." else "Some stock changes may have saved. The screen has been refreshed; review the latest quantities and retry any remaining changes.")
                    refreshed.put("notice_is_error", failure != null)
                    refreshed.toString()
                },
                { result ->
                    if (!isScreenCurrent()) return@launch
                    saving = false
                    savingInventorySlot = null
                    val refreshed = JSONObject(result)
                    renderList(refreshed, refreshed.optString("notice").takeIf { it.isNotBlank() }, refreshed.optBoolean("notice_is_error"))
                },
                { error ->
                    if (!isScreenCurrent()) return@launch
                    saving = false
                    savingInventorySlot = null
                    saveButton.isEnabled = true
                    saveButton.text = "Save inventory"
                    feedback.text = error.message ?: "Could not save inventory. Refresh and try again."
                },
            )
        }
        parent.addView(card, matchWrap(bottom = 12))
    }

    private fun saveInventoryChange(slotId: String, change: InventoryChange) {
        assertScope()
        val body = JSONObject().put("available_qty", change.quantity)
        try {
            if (change.exists) {
                request("/rest/v1/slot_item_inventory?slot_id=eq.$slotId&item_id=eq.${change.itemId}", "PATCH", body)
            } else {
                request("/rest/v1/slot_item_inventory", "POST", JSONObject()
                    .put("slot_id", slotId)
                    .put("item_id", change.itemId)
                    .put("available_qty", change.quantity))
            }
        } catch (error: Exception) {
            // PATCH/POST can commit before a mobile timeout. Read the row before reporting failure.
            val current = runCatching { fetchInventory(slotId, change.itemId) }.getOrNull()
            if (current?.optInt("available_qty", -1) == change.quantity &&
                current.optInt("reserved_qty", 0) <= change.quantity) return
            throw error
        }
    }

    private fun fetchInventory(slotId: String, itemId: String): JSONObject? {
        assertScope()
        val rows = JSONArray(request(
            "/rest/v1/slot_item_inventory?select=item_id,available_qty,reserved_qty&slot_id=eq.$slotId&item_id=eq.$itemId&limit=1",
            "GET",
            null,
        ))
        return rows.optJSONObject(0)
    }

    private fun renderCreateForm() {
        if (creatingSlot) return
        val content = newPage("Create pickup window")
        addText(content, "For $restaurantName · times use ${zone.id}. This window is available to guests as soon as it is created.")
        val start = addField(content, "Start date and time · YYYY-MM-DD HH:mm", defaultStart())
        val duration = addField(content, "Pickup window length · minutes", "15", InputType.TYPE_CLASS_NUMBER)
        val cutoff = addField(content, "Order cutoff before start · minutes", "25", InputType.TYPE_CLASS_NUMBER)
        val capacity = addField(content, "Order capacity", "8", InputType.TYPE_CLASS_NUMBER)
        addText(content, "Initial stock is 8 portions for each selected meal kit.")
        val orderableItems = (0 until loadedItems.length()).mapNotNull { loadedItems.optJSONObject(it) }
            .filter(::isOrderable)
        val selected = linkedMapOf<String, CheckBox>()
        if (orderableItems.isEmpty()) {
            addText(content, "Publish at least one meal kit before creating a pickup window.")
        } else {
            addTitle(content, "Meal kits to stock", 17f)
            for (item in orderableItems) {
                val id = item.nonBlank("id") ?: continue
                val name = item.nonBlank("name") ?: "Meal kit"
                val check = CheckBox(activity).apply {
                    text = name
                    setTextColor(wine)
                    isChecked = true
                    contentDescription = "Stock $name in this pickup window"
                }
                content.addView(check, matchWrap())
                selected[id] = check
            }
        }
        val errorView = TextView(activity).apply {
            setTextColor(coral)
            textSize = 13f
            setPadding(0, dp(6), 0, dp(8))
        }
        content.addView(errorView, matchWrap())
        var busy = false
        lateinit var createButton: Button
        createButton = addButtonEnabled(content, "Create pickup window", orderableItems.isNotEmpty()) {
            if (busy || creatingSlot) return@addButtonEnabled
            val parsedStart = runCatching { LocalDateTime.parse(start.text.toString().trim(), localFormat) }.getOrNull()
            val durationMinutes = duration.text.toString().trim().toIntOrNull()
            val cutoffMinutes = cutoff.text.toString().trim().toIntOrNull()
            val orderCapacity = capacity.text.toString().trim().toIntOrNull()
            when {
                parsedStart == null -> errorView.text = "Enter the start time as YYYY-MM-DD HH:mm in ${zone.id}."
                durationMinutes == null || durationMinutes !in 5..180 -> errorView.text = "Window length must be between 5 and 180 minutes."
                cutoffMinutes == null || cutoffMinutes !in 0..240 -> errorView.text = "Order cutoff must be between 0 and 240 minutes before start."
                orderCapacity == null || orderCapacity !in 1..500 -> errorView.text = "Order capacity must be between 1 and 500."
                else -> {
                    val validOffsets = zone.rules.getValidOffsets(parsedStart)
                    if (validOffsets.isEmpty()) {
                        errorView.text = "That local time does not exist because of a clock change. Choose another start time."
                        return@addButtonEnabled
                    }
                    if (validOffsets.size > 1) {
                        errorView.text = "That local time occurs twice because of a clock change. Choose an unambiguous start time."
                        return@addButtonEnabled
                    }
                    val startsAt = runCatching { parsedStart.toInstant(validOffsets.single()) }.getOrNull()
                    if (startsAt == null || !startsAt.isAfter(Instant.now().plusSeconds(cutoffMinutes * 60L))) {
                        errorView.text = "Start time must be after the order cutoff."
                        return@addButtonEnabled
                    }
                    val itemIds = selected.filterValues { it.isChecked }.keys.toList().sorted()
                    if (itemIds.isEmpty()) {
                        errorView.text = "Choose at least one meal kit to stock."
                        return@addButtonEnabled
                    }
                    val endsAt = startsAt.plusSeconds(durationMinutes * 60L)
                    val cutoffAt = startsAt.minusSeconds(cutoffMinutes * 60L)
                    val payload = JSONObject()
                        .put("p_restaurant_id", restaurantId)
                        .put("p_item_ids", JSONArray(itemIds))
                        .put("p_starts_at", startsAt.toString())
                        .put("p_window_minutes", durationMinutes)
                        .put("p_cutoff_minutes", cutoffMinutes)
                        .put("p_capacity", orderCapacity)
                    if (findExactSlot(loadedSlots, startsAt, endsAt, cutoffAt, orderCapacity, itemIds) != null) {
                        errorView.text = "This exact pickup window already exists. Refresh the list to review its stock."
                        return@addButtonEnabled
                    }
                    busy = true
                    creatingSlot = true
                    createButton.isEnabled = false
                    createButton.text = "Creating pickup window…"
                    errorView.text = ""
                    launcher.launch(
                        {
                            var createError: Exception? = null
                            try {
                                request("/rest/v1/rpc/create_pickup_slot_with_inventory", "POST", payload)
                            } catch (error: Exception) {
                                createError = error
                            }
                            val refreshed = try { loadData() } catch (refreshError: Exception) {
                                if (createError != null) throw createError!!
                                // The RPC committed, but the window list could not be refreshed.
                                JSONObject().put("items", loadedItems).put("slots", loadedSlots)
                                    .put("notice", "Pickup window created. Refresh the list to confirm its current stock.")
                                    .put("notice_is_error", true)
                            }
                            val recovered = findExactSlot(refreshed.getJSONArray("slots"), startsAt, endsAt, cutoffAt, orderCapacity, itemIds) != null
                            if (createError != null && !recovered) throw createError!!
                            if (createError != null) refreshed.put("notice", "Pickup window creation was confirmed after a connection interruption.")
                            refreshed.toString()
                        },
                        { result ->
                            if (!isScreenCurrent()) return@launch
                            busy = false
                            creatingSlot = false
                            val refreshed = JSONObject(result)
                            renderList(refreshed, refreshed.optString("notice").takeIf { it.isNotBlank() }, refreshed.optBoolean("notice_is_error"))
                        },
                        { error ->
                            if (!isScreenCurrent()) return@launch
                            busy = false
                            creatingSlot = false
                            createButton.isEnabled = true
                            createButton.text = "Create pickup window"
                            errorView.text = error.message ?: "Could not create this pickup window. Refresh to check whether it was saved before retrying."
                        },
                    )
                }
            }
        }
        addButton(content, "Back to pickup windows") { show() }
        showPage(content)
    }

    private fun findExactSlot(
        slots: JSONArray,
        startsAt: Instant,
        endsAt: Instant,
        cutoffAt: Instant,
        capacity: Int,
        itemIds: List<String>,
    ): JSONObject? {
        for (index in 0 until slots.length()) {
            val slot = slots.optJSONObject(index) ?: continue
            if (slot.nonBlank("restaurant_id") != restaurantId ||
                parseInstant(slot.nonBlank("starts_at")) != startsAt ||
                parseInstant(slot.nonBlank("ends_at")) != endsAt ||
                parseInstant(slot.nonBlank("cutoff_at")) != cutoffAt ||
                slot.optInt("capacity", -1) != capacity || !slot.optBoolean("active")) continue
            val stock = slot.optJSONArray("slot_item_inventory") ?: JSONArray()
            val byItem = linkedMapOf<String, JSONObject>()
            for (rowIndex in 0 until stock.length()) {
                val row = stock.optJSONObject(rowIndex) ?: continue
                row.nonBlank("item_id")?.let { byItem[it] = row }
            }
            if (byItem.keys != itemIds.toSet()) continue
            // Checkout increments reserved_qty but leaves available_qty as the stock ceiling.
            // A just-created slot remains recognizable after an immediate reservation.
            if (itemIds.all { id -> byItem[id]?.let { it.optInt("available_qty", -1) == INITIAL_ITEM_STOCK } == true }) return slot
        }
        return null
    }

    private fun parseInstant(value: String?): Instant? = value?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private fun isOrderable(item: JSONObject): Boolean =
        item.optBoolean("active") && item.nonBlank("published_at") != null

    private fun defaultStart(): String = LocalDateTime.now(zone)
        .plusHours(2)
        .withMinute(0)
        .withSecond(0)
        .withNano(0)
        .format(localFormat)

    private fun formatInstant(value: String): String = runCatching {
        Instant.parse(value).atZone(zone).format(dateFormat)
    }.getOrDefault("Time unavailable")

    private fun formatInstantTime(value: String): String = runCatching {
        Instant.parse(value).atZone(zone).format(DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault()))
    }.getOrDefault("Time unavailable")

    private fun newPage(title: String): LinearLayout {
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(28))
            background = android.graphics.drawable.ColorDrawable(ivory)
        }
        addTitle(content, title, 23f)
        return content
    }

    private fun showPage(content: LinearLayout) {
        val outer = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(ivory)
        }
        content.layoutParams = LinearLayout.LayoutParams(
            activity.resources.displayMetrics.widthPixels.coerceAtMost((680 * activity.resources.displayMetrics.density).toInt()),
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        outer.addView(content)
        val scroll = ScrollView(activity).apply {
            isVerticalScrollBarEnabled = false
            addView(outer)
        }
        activity.setContentView(scroll)
    }

    private fun newCard(): LinearLayout = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(14), dp(16), dp(14))
        background = outline(rose, paper, 16f)
    }

    private fun addTitle(parent: LinearLayout, value: String, size: Float) {
        parent.addView(TextView(activity).apply {
            text = value
            textSize = size
            setTextColor(wine)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(0, dp(6), 0, dp(7))
        }, matchWrap())
    }

    private fun addText(parent: LinearLayout, value: String) {
        parent.addView(TextView(activity).apply {
            text = value
            textSize = 14f
            setTextColor(clay)
            setPadding(0, dp(4), 0, dp(7))
        }, matchWrap())
    }

    private fun addNotice(parent: LinearLayout, value: String, error: Boolean) {
        parent.addView(TextView(activity).apply {
            text = value
            textSize = 13f
            setTextColor(if (error) coral else clay)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = outline(if (error) coral else rose, paper, 12f)
        }, matchWrap(bottom = 10))
    }

    private fun addButton(parent: LinearLayout, label: String, action: () -> Unit): Button =
        addButtonEnabled(parent, label, true, action)

    private fun addButtonEnabled(parent: LinearLayout, label: String, enabled: Boolean, action: () -> Unit): Button {
        val button = Button(activity).apply {
            text = label
            isEnabled = enabled
            setTextColor(Color.WHITE)
            contentDescription = label
            background = GradientDrawable().apply {
                setColor(wine)
                cornerRadius = 18f * activity.resources.displayMetrics.density
            }
            setOnClickListener { action() }
        }
        parent.addView(button, matchWrap(bottom = 9))
        return button
    }

    private fun addField(parent: LinearLayout, label: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText {
        addText(parent, label)
        return EditText(activity).apply {
            hint = label
            setText(value)
            inputType = type
            setSingleLine(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = outline(rose, paper, 10f)
            parent.addView(this, matchWrap(bottom = 7))
        }
    }

    private fun outline(stroke: Int, fill: Int, radius: Float) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = radius * activity.resources.displayMetrics.density
        setStroke(dp(1), stroke)
    }

    private fun matchWrap(bottom: Int = 0) = LinearLayout.LayoutParams(-1, -2).apply {
        bottomMargin = dp(bottom)
    }

    private fun dp(value: Int): Int = (value * activity.resources.displayMetrics.density).toInt()

    private fun JSONObject.nonBlank(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key).trim().takeIf { it.isNotEmpty() && it != "null" }
    }

    private data class StockInput(
        val name: String,
        val available: Int,
        val reserved: Int,
        val exists: Boolean,
        val field: EditText,
    )

    private data class InventoryChange(
        val itemId: String,
        val name: String,
        val quantity: Int,
        val reserved: Int,
        val exists: Boolean,
    )

    companion object {
        private const val INITIAL_ITEM_STOCK = 8
    }
}
