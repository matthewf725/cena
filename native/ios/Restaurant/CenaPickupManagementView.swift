import SwiftUI

struct CenaPickupManagementView: View {
    let restaurantID: String
    let restaurantTimezone: String?
    let catalogItems: [[String: Any]]

    @StateObject private var api = CenaBackend.shared
    @State private var slots: [[String: Any]] = []
    @State private var startsAt = Date().addingTimeInterval(2 * 60 * 60)
    @State private var windowMinutes = 90
    @State private var cutoffMinutes = 45
    @State private var capacity = 20
    @State private var selectedItemIDs: Set<String>
    @State private var inventoryDrafts: [String: String] = [:]
    @State private var loading = false
    @State private var savingSlot = false
    @State private var savingInventorySlotID: String?
    @State private var publishingSlotID: String?
    @State private var notice: String?

    init(restaurantID: String, restaurantTimezone: String?, catalogItems: [[String: Any]]) {
        self.restaurantID = restaurantID
        self.restaurantTimezone = restaurantTimezone
        self.catalogItems = catalogItems
        let itemIDs = catalogItems.filter(Self.isOrderable).map { pickupString($0["id"]) }.filter { !$0.isEmpty }
        _selectedItemIDs = State(initialValue: Set(itemIDs))
    }

    private var timezone: TimeZone? { restaurantTimezone.flatMap(TimeZone.init(identifier:)) }
    private var displayTimezone: TimeZone { timezone ?? .current }
    private var orderableItems: [[String: Any]] { catalogItems.filter(Self.isOrderable) }

    var body: some View {
        Form {
            Section("New pickup window") {
                if let timezone { Text("Times are shown in \(timezone.identifier). Cena stores the corresponding UTC instants.").font(.caption).foregroundStyle(CenaStyle.clay) }
                else { Label("Restaurant timezone is unavailable; times use this device’s timezone (\(displayTimezone.identifier)).", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(CenaStyle.coral) }
                DatePicker("Pickup starts", selection: $startsAt, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .environment(\.timeZone, displayTimezone)
                Stepper("Pickup window · \(windowMinutes) min", value: $windowMinutes, in: 5...180, step: 5)
                Stepper("Order cutoff · \(cutoffMinutes) min before", value: $cutoffMinutes, in: 0...240, step: 5)
                Stepper("Order capacity · \(capacity)", value: $capacity, in: 1...500)
                if orderableItems.isEmpty {
                    Text("Publish an active menu item before adding a pickup window.").font(.caption).foregroundStyle(CenaStyle.clay)
                } else {
                    DisclosureGroup("Items available in this window (\(selectedItemIDs.count))") {
                        ForEach(Array(orderableItems.enumerated()), id: \.offset) { _, item in
                            itemToggle(item)
                        }
                    }
                }
                Button(savingSlot ? "Creating window…" : "Create pickup window") { Task { await createPickupWindow() } }
                    .disabled(savingSlot || loading || orderableItems.isEmpty || selectedItemIDs.isEmpty || !api.configured || !validSchedule)
                if !api.configured { Text("Connect Supabase to create pickup windows.").font(.caption).foregroundStyle(CenaStyle.coral) }
                if !validSchedule { Text("Choose a pickup time at least 32 minutes away with a future order cutoff and at least one item.").font(.caption).foregroundStyle(CenaStyle.clay) }
            }

            if let notice { Section { Text(notice).font(.subheadline).foregroundStyle(notice.hasPrefix("Couldn’t") ? CenaStyle.maroon : CenaStyle.clay) } }

            Section("Upcoming windows") {
                if loading { ProgressView("Loading pickup windows…") }
                else if slots.isEmpty { Text("No upcoming pickup windows for this location.").foregroundStyle(CenaStyle.clay) }
                ForEach(Array(slots.enumerated()), id: \.offset) { _, slot in
                    slotEditor(slot)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollIndicators(.hidden)
        .background(CenaStyle.cream)
        .tint(CenaStyle.maroon)
        .navigationTitle("Pickup planning")
        .task { await loadSlots() }
        .refreshable { await loadSlots() }
        .overlay(alignment: .top) {
            if let notice, notice.hasPrefix("Couldn’t") {
                CenaNotice(message: notice) { self.notice = nil }.padding(.horizontal, 14).padding(.top, 8)
            }
        }
    }

    private var validSchedule: Bool {
        let cutoff = startsAt.addingTimeInterval(-Double(cutoffMinutes * 60))
        let now = Date()
        return startsAt > now.addingTimeInterval(32 * 60) && cutoff >= now && (5...180).contains(windowMinutes) && (0...240).contains(cutoffMinutes) && (1...500).contains(capacity) && !selectedItemIDs.isEmpty
    }

    @ViewBuilder private func slotEditor(_ slot: [String: Any]) -> some View {
        let slotID = pickupString(slot["id"])
        let inventory = slot["slot_item_inventory"] as? [[String: Any]] ?? []
        let cutoff = parseDate(slot["cutoff_at"])
        VStack(alignment: .leading, spacing: 10) {
            Text(dateRange(slot)).font(.headline)
            Text("Capacity \(pickupInt(slot["capacity"])) · \(pickupInt(slot["reserved_count"])) orders reserved")
                .font(.caption).foregroundStyle(CenaStyle.clay)
            if slot["active"] as? Bool == false {
                Label("Draft · hidden from customers", systemImage: "lock").font(.caption).foregroundStyle(CenaStyle.clay)
                Button(publishingSlotID == slotID ? "Publishing…" : "Publish pickup window") {
                    Task { await publishWindow(slotID) }
                }
                .buttonStyle(.bordered)
                .disabled(publishingSlotID != nil || !inventory.contains { pickupInt($0["available_qty"]) > 0 })
            }
            if let cutoff {
                Label(cutoff > Date() ? "Order cutoff \(formatted(cutoff))" : "Order cutoff passed · ordering closed", systemImage: "clock")
                    .font(.caption.weight(.semibold)).foregroundStyle(cutoff > Date() ? .green : CenaStyle.coral)
            }
            if orderableItems.isEmpty {
                Text("There are no active published menu items to stock.").font(.caption).foregroundStyle(CenaStyle.clay)
            } else {
                ForEach(Array(orderableItems.enumerated()), id: \.offset) { _, item in
                    let itemID = pickupString(item["id"])
                    let row = inventory.first { pickupString($0["item_id"]) == itemID }
                    let reserved = pickupInt(row?["reserved_qty"])
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(pickupString(item["name"])).font(.subheadline.weight(.medium))
                            Text("\(reserved) reserved").font(.caption).foregroundStyle(CenaStyle.clay)
                        }
                        Spacer(minLength: 8)
                        TextField("0", text: inventoryBinding(slotID: slotID, itemID: itemID, initial: pickupInt(row?["available_qty"])))
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(width: 78)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Available quantity for \(pickupString(item["name"]))")
                    }
                }
                Button(savingInventorySlotID == slotID ? "Saving inventory…" : "Save inventory") {
                    Task { await saveInventory(slotID: slotID, rows: inventory) }
                }
                .disabled(savingInventorySlotID != nil || loading || !api.configured)
                .buttonStyle(.bordered)
                .tint(CenaStyle.maroon)
            }
        }
        .padding(.vertical, 5)
    }

    private func inventoryBinding(slotID: String, itemID: String, initial: Int) -> Binding<String> {
        let key = inventoryKey(slotID, itemID)
        return Binding(
            get: { inventoryDrafts[key] ?? String(initial) },
            set: { inventoryDrafts[key] = $0 }
        )
    }

    private func itemToggle(_ item: [String: Any]) -> some View {
        let id = pickupString(item["id"])
        return Toggle(pickupString(item["name"]), isOn: Binding(
            get: { selectedItemIDs.contains(id) },
            set: { selected in
                if selected { selectedItemIDs.insert(id) } else { selectedItemIDs.remove(id) }
            }
        ))
    }

    private func inventoryKey(_ slotID: String, _ itemID: String) -> String { "\(slotID):\(itemID)" }

    private func createPickupWindow() async {
        guard !savingSlot else { return }
        guard validSchedule else { notice = "Choose a future pickup time and valid inventory before creating a window."; return }
        savingSlot = true; notice = nil; defer { savingSlot = false }
        let starts = startsAt
        let ends = starts.addingTimeInterval(Double(windowMinutes * 60))
        let cutoff = starts.addingTimeInterval(-Double(cutoffMinutes * 60))
        let body: [String: Any] = [
            "restaurant_id": restaurantID,
            "starts_at": isoString(starts),
            "ends_at": isoString(ends),
            "cutoff_at": isoString(cutoff),
            "capacity": capacity,
            "active": false
        ]
        let selectedItems = selectedItemIDs.sorted()
        var createdSlotID: String?
        do {
            let response = try await api.insert("pickup_slots", body: body, authenticated: true)
            guard let created = (try JSONSerialization.jsonObject(with: response) as? [[String: Any]])?.first,
                  let slotID = created["id"] as? String else { throw CenaBackendError.invalidResponse }
            createdSlotID = slotID
            let inventory: [[String: Any]] = selectedItems.map { itemID in
                [
                    "slot_id": slotID,
                    "item_id": itemID,
                    "available_qty": 8
                ]
            }
            _ = try await api.insert("slot_item_inventory", body: inventory, authenticated: true)
            _ = try await api.patch("pickup_slots", query: "id=eq.\(slotID)", body: ["active": true], authenticated: true)
            notice = "Pickup window created with inventory for \(selectedItems.count) menu items."
            startsAt = nextDefaultStart(after: ends)
            await loadSlots()
        } catch {
            await loadSlots()
            notice = createdSlotID == nil
                ? "Couldn’t create this pickup window: \(error.localizedDescription)"
                : "Couldn’t publish this pickup window: \(error.localizedDescription). Check the window and inventory before retrying."
        }
    }

    private func saveInventory(slotID: String, rows: [[String: Any]]) async {
        guard savingInventorySlotID == nil else { return }
        savingInventorySlotID = slotID; notice = nil; defer { savingInventorySlotID = nil }
        do {
            let changes = try orderableItems.compactMap { item -> (itemID: String, quantity: Int, exists: Bool)? in
                let itemID = pickupString(item["id"])
                let row = rows.first { pickupString($0["item_id"]) == itemID }
                let reserved = pickupInt(row?["reserved_qty"])
                guard let requested = Int(inventoryDrafts[inventoryKey(slotID, itemID)] ?? String(pickupInt(row?["available_qty"]))), requested >= 0 else {
                    throw CenaBackendError.server("Enter a whole, non-negative quantity for \(pickupString(item["name"])).")
                }
                guard requested >= reserved else {
                    throw CenaBackendError.server("Available quantity for \(pickupString(item["name"])) cannot be below the \(reserved) already reserved.")
                }
                guard requested != pickupInt(row?["available_qty"]) else { return nil }
                return (itemID, requested, row != nil)
            }
            for change in changes {
                if change.exists {
                    _ = try await api.patch("slot_item_inventory", query: "slot_id=eq.\(slotID)&item_id=eq.\(change.itemID)", body: ["available_qty": change.quantity], authenticated: true)
                } else {
                    _ = try await api.insert("slot_item_inventory", body: ["slot_id": slotID, "item_id": change.itemID, "available_qty": change.quantity], authenticated: true)
                }
            }
            notice = changes.isEmpty ? "There are no inventory changes to save." : "Inventory saved."
            await loadSlots()
        } catch { notice = "Couldn’t save inventory: \(error.localizedDescription)" }
    }

    private func loadSlots() async {
        guard !restaurantID.isEmpty, api.configured, api.signedIn else { return }
        loading = true; defer { loading = false }
        do {
            let rows = try await api.rows("pickup_slots", query: "select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,active,slot_item_inventory(slot_id,item_id,available_qty,reserved_qty)&restaurant_id=eq.\(restaurantID)&starts_at=gt.\(isoString(Date()))&order=starts_at.asc", authenticated: true)
            slots = rows
            var drafts: [String: String] = [:]
            for slot in rows {
                let slotID = pickupString(slot["id"])
                for row in slot["slot_item_inventory"] as? [[String: Any]] ?? [] {
                    drafts[inventoryKey(slotID, pickupString(row["item_id"]))] = String(pickupInt(row["available_qty"]))
                }
            }
            inventoryDrafts = drafts
        } catch { notice = "Couldn’t load pickup windows: \(error.localizedDescription)" }
    }

    private func publishWindow(_ slotID: String) async {
        guard publishingSlotID == nil else { return }
        publishingSlotID = slotID
        defer { publishingSlotID = nil }
        do {
            _ = try await api.patch("pickup_slots", query: "id=eq.\(slotID)", body: ["active": true], authenticated: true)
            notice = "Pickup window published."
            await loadSlots()
        } catch { notice = "Couldn’t publish this pickup window: \(error.localizedDescription)" }
    }

    private func dateRange(_ slot: [String: Any]) -> String {
        guard let starts = parseDate(slot["starts_at"]), let ends = parseDate(slot["ends_at"]) else { return "Pickup time unavailable" }
        return "\(formatted(starts)) – \(formatted(ends))"
    }

    private func formatted(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = displayTimezone
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func nextDefaultStart(after date: Date) -> Date {
        let proposed = date.addingTimeInterval(60 * 60)
        let components = Calendar(identifier: .gregorian).dateComponents(in: displayTimezone, from: proposed)
        var next = Calendar(identifier: .gregorian).date(from: DateComponents(timeZone: displayTimezone, year: components.year, month: components.month, day: components.day, hour: components.hour, minute: 0)) ?? proposed
        if next < proposed { next = next.addingTimeInterval(60 * 60) }
        return next
    }

    private func parseDate(_ value: Any?) -> Date? {
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func isOrderable(_ item: [String: Any]) -> Bool {
        guard item["active"] as? Bool == true else { return false }
        guard let published = item["published_at"], !(published is NSNull) else { return false }
        return true
    }
}

private func pickupString(_ value: Any?) -> String { value as? String ?? "" }
private func pickupInt(_ value: Any?) -> Int { (value as? Int) ?? ((value as? NSNumber)?.intValue ?? 0) }
