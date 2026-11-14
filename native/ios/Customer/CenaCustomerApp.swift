import SwiftUI
import UIKit

@main struct CenaCustomerApp: App {
    var body: some Scene { WindowGroup { CustomerHome().tint(CenaStyle.maroon) } }
}

struct CustomerHome: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var api = CenaBackend.shared
    @State private var items: [[String: Any]] = []
    @State private var recentRestaurants: [[String: Any]] = []
    @State private var exploreMeals: [[String: Any]] = []
    @State private var nearbyRestaurants: [[String: Any]] = []
    @State private var categoryRails: [[String: Any]] = []
    @State private var nextFeedCursor: String?
    @State private var recentRestaurantIDs: [String] = []
    @State private var recentHistoryUnavailable = false
    @State private var loadingMore = false
    @State private var moreError: String?
    @State private var slots: [[String: Any]] = []
    @State private var restaurant: [String: Any]?
    @State private var slot: [String: Any]?
    @State private var cart: [String: Int] = [:]
    @State private var tab = 0
    @State private var email = "", code = "", phone = ""
    @State private var curbside = false, vehicleMake = "", vehicleModel = "", vehicleColor = ""
    @State private var codeSent = false
    @State private var idempotencyKey = UUID().uuidString
    @State private var busy = false
    @State private var message: String?
    @State private var orderNumber: String?
    private var subtotal: Int { cart.reduce(0) { sum, entry in sum + entry.value * (items.first(where: { str($0["id"]) == entry.key }).map { int($0["price_cents"]) } ?? 0) } }
    private var restaurantItems: [[String: Any]] {
        guard let slot else { return [] }
        let availability = Dictionary(uniqueKeysWithValues: inventory(slot).map { (str($0["item_id"]), max(0, int($0["available_qty"]) - int($0["reserved_qty"]))) })
        return items.filter { str($0["restaurant_id"]) == str(restaurant?["id"]) && availability[str($0["id"]), default: 0] > 0 }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let orderNumber { orderConfirmation(orderNumber).transition(smoothTransition) }
                else if tab == 1 { orderHistory.transition(smoothTransition) }
                else if let restaurant { menuScreen(restaurant).transition(smoothTransition) }
                else { homeScreen.transition(smoothTransition) }
            }
            .fontDesign(.default)
            .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: restaurant?["id"] as? String)
            .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: tab)
            .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: orderNumber)
            .frame(maxWidth: horizontalSizeClass == .regular ? 760 : .infinity)
            .frame(maxWidth: .infinity, alignment: .top)
            .navigationTitle(restaurant == nil ? "cena" : (str(restaurant?["name"]).isEmpty ? "Menu" : str(restaurant?["name"])))
            .toolbar { if restaurant != nil { ToolbarItem(placement: .topBarLeading) { Button("Kitchens") { self.restaurant = nil; slots = []; slot = nil } } } }
            .safeAreaInset(edge: .bottom) {
                if restaurant == nil && orderNumber == nil {
                    HStack { tabButton("Discover", icon: "fork.knife", value: 0); tabButton("Orders", icon: "bag", value: 1) }
                        .padding(.vertical, 10).background(.white)
                }
            }
            .background(CenaStyle.cream)
            .overlay(alignment: .top) { if let message { CenaNotice(message: message) { self.message = nil }.padding(.horizontal, 14).padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)) } }
            .animation(.easeInOut(duration: 0.2), value: message)
            .task { await load() }
        }
    }

    private var homeScreen: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Dinner, made\na little easier.").font(.largeTitle.weight(.bold)).fontDesign(.default).foregroundStyle(CenaStyle.maroon)
                    Text("Local meal kits, prepared by neighborhood kitchens.").foregroundStyle(.secondary)
                    if !api.configured { Label("Connect Supabase to browse live menus.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                    else { Text("Approximate miles from the San Francisco pickup area reference.").font(.caption).foregroundStyle(.secondary) }
                }.padding(.horizontal, 20).padding(.top, 12)
                recentRail
                mealExploreRail
                restaurantRail(title: "Near you", subtitle: "Using the San Francisco pickup area reference.", values: nearbyRestaurants)
                ForEach(Array(categoryRails.enumerated()), id: \.offset) { _, category in
                    restaurantRail(title: str(category["name"]), subtitle: "Local kitchens", values: category["restaurants"] as? [[String: Any]] ?? [])
                }
                if let cursor = nextFeedCursor {
                    Color.clear.frame(height: 1).task(id: cursor) { await loadMore(cursor: cursor) }
                    if loadingMore { ProgressView().tint(CenaStyle.maroon).frame(maxWidth: .infinity).padding(.vertical, 10) }
                    if let moreError {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(moreError).font(.caption).foregroundStyle(.secondary)
                            Button("Retry loading kitchens") { Task { await loadMore(cursor: cursor) } }.buttonStyle(.bordered).tint(CenaStyle.maroon)
                        }.padding(.horizontal, 20)
                    }
                }
                if !api.configured { Text("Live discovery requires a backend connection.").foregroundStyle(.secondary).padding(.horizontal, 20) }
                else if nearbyRestaurants.isEmpty && exploreMeals.isEmpty && recentRestaurants.isEmpty { Text("No kitchens with upcoming pickup are available yet. Check back soon.").foregroundStyle(.secondary).padding(.horizontal, 20) }
            }.padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .refreshable { await load() }
    }

    private var recentRail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Recents").font(.title2.weight(.bold)).padding(.horizontal, 20)
            if !api.signedIn { Text("Sign in during checkout to keep your recent kitchens here.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
            else if recentHistoryUnavailable { Text("Sign in again to see your past kitchens. Nearby pickup is still available.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
            else if recentRestaurants.isEmpty { Text("Your past kitchens will appear here after your first order.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
            else { restaurantRail(title: nil, subtitle: nil, values: recentRestaurants) }
        }
    }

    private var mealExploreRail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Explore meal kits").font(.title2.weight(.bold)).padding(.horizontal, 20)
            if exploreMeals.isEmpty { Text(api.configured ? "Meal kits appear here when kitchens publish pickup inventory." : "Live meal kits will appear when connected.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
            else {
                GeometryReader { geometry in
                    let cardWidth = min(270, max(224, geometry.size.width * 0.72))
                    ScrollView(.horizontal) {
                        LazyHStack(spacing: 14) {
                            ForEach(Array(exploreMeals.enumerated()), id: \.offset) { _, entry in
                                let meal = entry["meal"] as? [String: Any] ?? [:]
                                let kitchen = entry["restaurant"] as? [String: Any] ?? [:]
                                let card = mealCard(meal, kitchen: kitchen, width: cardWidth)
                                if reduceMotion { card }
                                else { card.scrollTransition(.animated(.spring(duration: 0.34)), axis: .horizontal) { content, phase in content.scaleEffect(phase.isIdentity ? 1 : 0.96).opacity(phase.isIdentity ? 1 : 0.85) } }
                            }
                        }.scrollTargetLayout().padding(.horizontal, 20).padding(.vertical, 6)
                    }.scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned)
                }.frame(height: 254)
            }
        }
    }

    private func restaurantRail(title: String?, subtitle: String?, values: [[String: Any]]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if let title { Text(title).font(.title2.weight(.bold)).padding(.horizontal, 20) }
            if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20) }
            if values.isEmpty {
                if title != nil { Text("No kitchens in this section yet.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
            } else {
                GeometryReader { geometry in
                    let cardWidth = min(300, max(224, geometry.size.width * 0.76))
                    ScrollView(.horizontal) {
                        LazyHStack(spacing: 14) {
                            ForEach(Array(values.enumerated()), id: \.offset) { _, kitchen in
                                let card = kitchenCard(kitchen, width: cardWidth)
                                if reduceMotion { card }
                                else { card.scrollTransition(.animated(.spring(duration: 0.34)), axis: .horizontal) { content, phase in content.scaleEffect(phase.isIdentity ? 1 : 0.95).opacity(phase.isIdentity ? 1 : 0.82) } }
                            }
                        }.scrollTargetLayout().padding(.horizontal, 20).padding(.vertical, 6)
                    }.scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned)
                }.frame(height: 300)
            }
        }
    }

    private func kitchenCard(_ kitchen: [String: Any], width: CGFloat) -> some View {
        Button { Task { await open(kitchen) } } label: {
            VStack(alignment: .leading, spacing: 0) {
                foodPhoto(imageKey(for: kitchen)).frame(height: 158).frame(maxWidth: .infinity).clipped()
                    .overlay(alignment: .bottomLeading) { Text(str(kitchen["cuisine"])).font(.caption.weight(.semibold)).foregroundStyle(.white).padding(.horizontal, 10).padding(.vertical, 6).background(.black.opacity(0.48), in: Capsule()).padding(10) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(str(kitchen["name"])).font(.headline.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                    Text(str(kitchen["address"])).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    HStack(spacing: 5) {
                        if let number = kitchen["distance_miles"] as? NSNumber { Label(String(format: "≈ %.1f mi", number.doubleValue), systemImage: "location").font(.caption) }
                    }.foregroundStyle(CenaStyle.maroon).lineLimit(1)
                    cutoffBadge(kitchen["next_slot"] as? [String: Any])
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(width: width).cenaCardBackground(.white, outline: .black.opacity(0.05))
        }.buttonStyle(.plain).accessibilityLabel("\(str(kitchen["name"])), \(str(kitchen["cuisine"])), view menu")
    }

    private func mealCard(_ meal: [String: Any], kitchen: [String: Any], width: CGFloat) -> some View {
        Button { Task { await open(kitchen) } } label: {
            VStack(alignment: .leading, spacing: 0) {
                foodPhoto(imageKey(for: meal)).frame(height: 148).frame(maxWidth: .infinity).clipped()
                VStack(alignment: .leading, spacing: 4) {
                    Text(str(meal["name"])).font(.headline.weight(.bold)).lineLimit(1).foregroundStyle(.primary)
                    Text(str(kitchen["name"])).font(.caption).lineLimit(1).foregroundStyle(.secondary)
                    Text("$\(money(int(meal["price_cents"])))").font(.subheadline.weight(.semibold)).foregroundStyle(CenaStyle.maroon)
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(width: width).cenaCardBackground(.white, outline: .black.opacity(0.05))
        }.buttonStyle(.plain).accessibilityLabel("\(str(meal["name"])), from \(str(kitchen["name"])), \(money(int(meal["price_cents"]))) dollars")
    }

    @ViewBuilder private func cutoffBadge(_ slot: [String: Any]?) -> some View {
        if let slot, let cutoff = timestamp(slot["cutoff_at"]) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = max(0, Int(cutoff.timeIntervalSince(context.date)))
                let hours = remaining / 3600, minutes = (remaining % 3600) / 60, seconds = remaining % 60
                Text(remaining == 0 ? "Ordering closed" : "Order cutoff · \(String(format: "%02d:%02d:%02d", hours, minutes, seconds))")
                    .font(.caption.weight(.semibold)).foregroundStyle(remaining == 0 ? .red : .green)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .overlay { Capsule().stroke(remaining == 0 ? Color.red.opacity(0.65) : Color.green.opacity(0.75), lineWidth: 1) }
            }
        }
    }

    private func menuScreen(_ r: [String: Any]) -> some View {
        List {
            Section {
                Text(str(r["description"])).foregroundStyle(.secondary)
                if !slots.isEmpty {
                    Picker("Pickup window", selection: Binding(get: { str(slot?["id"]) }, set: { id in slot = slots.first { str($0["id"]) == id }; idempotencyKey = UUID().uuidString })) {
                        ForEach(Array(slots.enumerated()), id: \.offset) { _, s in Text(dateRange(s)).tag(str(s["id"])) }
                    }
                } else { Label("No upcoming pickup windows", systemImage: "clock").foregroundStyle(.secondary) }
                cutoffBadge(slot)
            }
            Section("Menu") {
                if restaurantItems.isEmpty { Text("No published menu items currently have pickup inventory.").foregroundStyle(.secondary) }
                ForEach(Array(restaurantItems.enumerated()), id: \.offset) { _, item in
                    let id = str(item["id"]), count = cart[id, default: 0]
                    HStack(alignment: .top, spacing: 12) {
                        foodPhoto(imageKey(for: item)).frame(width: 88, height: 96).clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(str(item["name"])).font(.headline)
                            Text(str(item["description"])).font(.subheadline).foregroundStyle(.secondary)
                            Text("$\(money(int(item["price_cents"]))) · \(str(item["prep_minutes"])) min").font(.subheadline.weight(.semibold)).foregroundStyle(CenaStyle.maroon)
                            if let steps = item["published_steps"] as? [String], !steps.isEmpty { Text(steps.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        Button { if count == 0 { cart[id] = 1 } else { cart.removeValue(forKey: id) }; idempotencyKey = UUID().uuidString } label: {
                            Text(count == 0 ? "Add" : "Added").font(.subheadline.weight(.bold)).padding(.horizontal, 13).padding(.vertical, 8).background(count == 0 ? CenaStyle.maroon : .gray.opacity(0.15)).foregroundStyle(count == 0 ? .white : .primary).clipShape(Capsule())
                        }
                    }.padding(14).cenaCardBackground(.white).padding(.vertical, 4)
                }
            }
            if !cart.isEmpty {
                Section("Your bag · $\(money(subtotal))") {
                    ForEach(Array(cart.keys.sorted()), id: \.self) { id in
                        if let item = items.first(where: { str($0["id"]) == id }) {
                            let maxQty = min(50, inventory(slot ?? [:]).filter { str($0["item_id"]) == id }.map { max(0, int($0["available_qty"]) - int($0["reserved_qty"])) }.first ?? 1)
                            HStack { Text(str(item["name"])); Spacer(); Stepper("\(cart[id, default: 0])", value: Binding(get: { cart[id, default: 0] }, set: { if $0 < 1 { cart.removeValue(forKey: id) } else { cart[id] = $0 }; idempotencyKey = UUID().uuidString }), in: 1...max(1, maxQty)).labelsHidden(); Text("×\(cart[id, default: 0])") }
                        }
                    }
                    NavigationLink { checkoutScreen } label: { Label("Continue to pickup", systemImage: "arrow.right").fontWeight(.semibold).foregroundStyle(CenaStyle.maroon) }
                        .disabled(slot == nil || !api.configured)
                    if !api.configured { Text("Checkout is disabled until Supabase is configured.").font(.caption).foregroundStyle(.orange) }
                }
            }
        }.scrollContentBackground(.hidden).scrollIndicators(.hidden)
    }

    private var checkoutScreen: some View {
        Form {
            Section("Pickup details") {
                Text(str(restaurant?["name"]))
                Text(slot.map(dateRange) ?? "Choose an available pickup window")
                Text("Payment is collected at pickup.").foregroundStyle(.secondary)
                if restaurant?["curbside_enabled"] as? Bool == true {
                    Toggle("Curbside pickup", isOn: Binding(get: { curbside }, set: { curbside = $0; idempotencyKey = UUID().uuidString }))
                    if curbside {
                        TextField("Vehicle make", text: Binding(get: { vehicleMake }, set: { vehicleMake = $0; idempotencyKey = UUID().uuidString }))
                        TextField("Vehicle model", text: Binding(get: { vehicleModel }, set: { vehicleModel = $0; idempotencyKey = UUID().uuidString }))
                        TextField("Vehicle color", text: Binding(get: { vehicleColor }, set: { vehicleColor = $0; idempotencyKey = UUID().uuidString }))
                    }
                }
                TextField("Email for your sign-in code", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress)
                if codeSent { TextField("One-time code", text: $code).keyboardType(.numberPad) }
                TextField("Phone (optional)", text: $phone).keyboardType(.phonePad)
            }
            Section("Order summary") { ForEach(Array(cart.keys.sorted()), id: \.self) { id in if let x = items.first(where: { str($0["id"]) == id }) { HStack { Text("\(cart[id, default: 0]) × \(str(x["name"]))"); Spacer(); Text("$\(money(int(x["price_cents"]) * cart[id, default: 0]))") } } }; HStack { Text("Subtotal").fontWeight(.bold); Spacer(); Text("$\(money(subtotal))").fontWeight(.bold) } }
            Section { Button(busy ? "Please wait…" : (codeSent ? "Verify & place order" : "Email me a sign-in code")) { Task { await place() } }.disabled(busy || email.isEmpty || (codeSent && code.isEmpty)) }
        }.scrollIndicators(.hidden).navigationTitle("Pickup checkout")
    }

    private var orderHistory: some View {
        List {
            Section { Text(api.signedIn ? "Orders placed with this account." : "Sign in during checkout to see order history.").font(.subheadline).foregroundStyle(.secondary) }
            if api.signedIn {
                ForEach(0..<history.count, id: \.self) { i in
                    let o = history[i]
                    VStack(alignment: .leading, spacing: 5) {
                        Text(str(o["status"]).capitalized).font(.headline)
                        Text("$\(money(int(o["subtotal_cents"]))) · \(str(o["pickup_mode"]).capitalized) pickup").font(.subheadline)
                        Text(str(o["pickup_starts_at"])).font(.caption).foregroundStyle(.secondary)
                        ForEach(Array(((o["order_items"] as? [[String: Any]]) ?? []).enumerated()), id: \.offset) { _, item in
                            Text("\(int(item["quantity"])) × \(str(item["name_snapshot"]))").font(.caption.weight(.medium))
                            if let steps = item["prep_steps_snapshot"] as? [String], !steps.isEmpty { Text(steps.joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary).lineLimit(3) }
                        }
                    }.padding(12).cenaCardBackground(.white)
                }
            }
            if api.signedIn && history.isEmpty { Text("No orders yet.").foregroundStyle(.secondary) }
        }.scrollContentBackground(.hidden).scrollIndicators(.hidden).navigationTitle("Your orders").task { await loadHistory() }
    }
    @State private var history: [[String: Any]] = []
    private func orderConfirmation(_ id: String) -> some View {
        VStack(spacing: 16) { Image(systemName: "checkmark.circle.fill").font(.system(size: 58)).foregroundStyle(.green); Text("Order placed").font(.largeTitle.bold()).fontDesign(.default).foregroundStyle(CenaStyle.maroon); Text("Order \(id.prefix(8).uppercased())").font(.headline); Text("Your kitchen has received it. Pickup and payment details are available in Orders.").multilineTextAlignment(.center).foregroundStyle(.secondary); Button("Back to kitchens") { orderNumber = nil; restaurant = nil; cart.removeAll(); slots = []; slot = nil; tab = 0; Task { await load() } }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon) }.padding(28).transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.97)))
    }
    private func tabButton(_ title: String, icon: String, value: Int) -> some View { Button { tab = value; restaurant = nil } label: { Label(title, systemImage: icon).frame(maxWidth: .infinity).foregroundStyle(tab == value ? CenaStyle.maroon : .secondary) } }
    private func load() async {
        guard api.configured else { message = "Supabase URL and public anon key are required for live discovery and checkout."; return }
        nextFeedCursor = nil; moreError = nil
        do {
            if api.signedIn {
                do {
                    let priorOrders = try await api.rows("orders", query: "select=restaurant_id,created_at&order=created_at.desc&limit=40", authenticated: true)
                    recentHistoryUnavailable = false
                    var seen = Set<String>()
                    recentRestaurantIDs = priorOrders.compactMap { row -> String? in
                        let id = str(row["restaurant_id"])
                        guard !id.isEmpty, seen.insert(id).inserted else { return nil }
                        return id
                    }
                } catch { recentRestaurantIDs = []; recentHistoryUnavailable = true }
            } else { recentRestaurantIDs = []; recentHistoryUnavailable = false }
            let feed = try await fetchDiscovery(after: nil)
            recentRestaurants = recentRestaurantIDs.isEmpty ? [] : (feed["recent"] as? [[String: Any]] ?? [])
            nearbyRestaurants = feed["nearby"] as? [[String: Any]] ?? []
            exploreMeals = feed["explore"] as? [[String: Any]] ?? []
            categoryRails = validCategories(feed["categories"] as? [[String: Any]] ?? [])
            nextFeedCursor = feed["next_cursor"] as? String
            moreError = nil
        } catch { message = error.localizedDescription }
    }

    private func fetchDiscovery(after cursor: String?) async throws -> [String: Any] {
        let response = try await api.rpc("discover_pickup_feed", body: [
            "p_latitude": 37.7749, "p_longitude": -122.4194,
            "p_after": cursor as Any? ?? NSNull(), "p_query": NSNull(), "p_cuisine": NSNull(),
            "p_recent_ids": recentRestaurantIDs
        ], authenticated: false)
        guard let feed = response as? [String: Any] else { throw CenaBackendError.invalidResponse }
        return feed
    }

    private func validCategories(_ categories: [[String: Any]]) -> [[String: Any]] {
        categories.filter { str($0["name"]).lowercased() != "all" && (($0["restaurants"] as? [[String: Any]])?.isEmpty == false) }
    }

    private func loadMore(cursor: String) async {
        guard !loadingMore else { return }
        loadingMore = true; moreError = nil; defer { loadingMore = false }
        do {
            let feed = try await fetchDiscovery(after: cursor)
            let incoming = validCategories(feed["categories"] as? [[String: Any]] ?? [])
            for category in incoming {
                let name = str(category["name"])
                let fresh = category["restaurants"] as? [[String: Any]] ?? []
                if let index = categoryRails.firstIndex(where: { str($0["name"]) == name }) {
                    let current = categoryRails[index]["restaurants"] as? [[String: Any]] ?? []
                    let ids = Set(current.map { str($0["id"]) })
                    categoryRails[index]["restaurants"] = current + fresh.filter { !ids.contains(str($0["id"])) }
                } else { categoryRails.append(category) }
            }
            if let nearby = feed["nearby"] as? [[String: Any]] {
                let ids = Set(nearbyRestaurants.map { str($0["id"]) })
                nearbyRestaurants += nearby.filter { !ids.contains(str($0["id"])) }
            }
            nextFeedCursor = feed["next_cursor"] as? String
        } catch { moreError = error.localizedDescription }
    }

    private func open(_ r: [String: Any]) async {
        restaurant = r; slots = []; slot = nil; items = []; curbside = false
        do {
            items = try await api.rows("catalog_items", query: "select=id,restaurant_id,name,description,price_cents,regular_price_cents,equipment,allergens,published_steps,image_key,category,prep_minutes&restaurant_id=eq.\(str(r["id"]))&active=eq.true&published_at=not.is.null&order=category.asc,name.asc")
            let all = try await api.rows("pickup_slots", query: "select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,slot_item_inventory(slot_id,item_id,available_qty,reserved_qty)&restaurant_id=eq.\(str(r["id"]))&active=eq.true&starts_at=gt.\(isoNow)&cutoff_at=gt.\(isoNow)&order=starts_at.asc")
            let liveIDs = Set(items.map { str($0["id"]) })
            slots = all.filter { s in inventory(s).contains { liveIDs.contains(str($0["item_id"])) && int($0["available_qty"]) > int($0["reserved_qty"]) } }
            slot = slots.first
        } catch { message = error.localizedDescription }
    }
    private func place() async {
        guard let r = restaurant, let s = slot, !cart.isEmpty else { message = "Choose a pickup window and add an available item."; return }
        busy = true; defer { busy = false }
        do {
            if !codeSent { try await api.sendCode(email: email); codeSent = true; message = "Check your email for the one-time code."; return }
            if !api.signedIn { try await api.verifyCode(email: email, code: code) }
            if curbside && ([vehicleMake, vehicleModel, vehicleColor].contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })) { throw CenaBackendError.server("Enter the vehicle make, model, and color for curbside pickup.") }
            let itemPayload = cart.map { ["item_id": $0.key, "quantity": $0.value] as [String: Any] }
            let vehicle: [String: String] = curbside ? ["make": vehicleMake.trimmingCharacters(in: .whitespacesAndNewlines), "model": vehicleModel.trimmingCharacters(in: .whitespacesAndNewlines), "color": vehicleColor.trimmingCharacters(in: .whitespacesAndNewlines)] : [:]
            let response = try await api.createOrder(["p_restaurant_id": str(r["id"]), "p_slot_id": str(s["id"]), "p_idempotency_key": idempotencyKey, "p_pickup_mode": curbside ? "curbside" : "counter", "p_vehicle": vehicle, "p_items": itemPayload])
            let obj = response as? [String: Any]; orderNumber = str(obj?["id"])
            if orderNumber?.isEmpty == true { throw CenaBackendError.invalidResponse }
            idempotencyKey = UUID().uuidString
        } catch { message = error.localizedDescription }
    }
    private func loadHistory() async {
        guard api.signedIn else { return }
        do { history = try await api.rows("orders", query: "select=id,status,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,pickup_mode,order_items(name_snapshot,quantity,prep_steps_snapshot)&order=created_at.desc&limit=20", authenticated: true) }
        catch { message = error.localizedDescription }
    }
    private func imageKey(for value: [String: Any]) -> String {
        let hint = (str(value["image_key"]) + " " + str(value["cuisine"]) + " " + str(value["name"]) + " " + str(value["category"])).lowercased()
        if hint.contains("taco") || hint.contains("mex") { return "tacos" }
        if hint.contains("pasta") || hint.contains("ital") || hint.contains("rigatoni") { return "rigatoni" }
        if hint.contains("salmon") || hint.contains("fish") { return "salmon" }
        return "mediterranean"
    }
    private var smoothTransition: AnyTransition { reduceMotion ? .identity : .move(edge: .trailing).combined(with: .opacity) }
    @ViewBuilder private func foodPhoto(_ key: String) -> some View {
        if let url = Bundle.main.url(forResource: key, withExtension: "webp"), let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill().accessibilityHidden(true)
        } else {
            ZStack { CenaStyle.cream; Image(systemName: "fork.knife").font(.largeTitle).foregroundStyle(CenaStyle.maroon.opacity(0.55)) }.accessibilityLabel("Food photo unavailable")
        }
    }
}

private var isoNow: String { ISO8601DateFormatter().string(from: Date()) }
private func str(_ v: Any?) -> String { (v as? String) ?? "" }
private func int(_ v: Any?) -> Int { (v as? Int) ?? ((v as? NSNumber)?.intValue ?? 0) }
private func money(_ cents: Int) -> String { String(format: "%.2f", Double(cents) / 100) }
private func inventory(_ slot: [String: Any]) -> [[String: Any]] { slot["slot_item_inventory"] as? [[String: Any]] ?? [] }
private func timestamp(_ value: Any?) -> Date? {
    guard let s = value as? String else { return nil }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}
private func dateRange(_ slot: [String: Any]) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let g = DateFormatter(); g.dateStyle = .medium; g.timeStyle = .short
    func date(_ key: String) -> Date? { let s = str(slot[key]); return f.date(from: s) ?? ISO8601DateFormatter().date(from: s) }
    guard let start = date("starts_at"), let end = date("ends_at") else { return "Pickup window" }
    return "\(g.string(from: start)) – \(DateFormatter.localizedString(from: end, dateStyle: .none, timeStyle: .short))"
}
