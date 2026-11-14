import SwiftUI
import UIKit

@main struct CenaCustomerApp: App {
    var body: some Scene { WindowGroup { CustomerHome().tint(CenaStyle.maroon) } }
}

struct CustomerHome: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var api = CenaBackend.shared
    @State private var restaurants: [[String: Any]] = []
    @State private var items: [[String: Any]] = []
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
        List {
            Section { VStack(alignment: .leading, spacing: 8) {
                Text("Dinner, made\na little easier.").font(.largeTitle.weight(.bold)).fontDesign(.default).foregroundStyle(CenaStyle.maroon)
                Text(api.configured ? "Local kitchens. Prepared kits. Pickup when it works for you." : "Connect Supabase to see live kitchens and pickup availability.").foregroundStyle(.secondary)
                if !api.configured { Text("Backend not configured").font(.caption.weight(.semibold)).foregroundStyle(.orange) }
            }.padding(.vertical, 8).listRowBackground(CenaStyle.cream) }
            Section("Kitchens near you") {
                if restaurants.isEmpty { Text(api.configured ? "No active kitchens are available right now." : "No live menu loaded.").foregroundStyle(.secondary) }
                else { kitchenCarousel }
            }
        }.scrollContentBackground(.hidden).refreshable { await load() }
    }

    private var kitchenCarousel: some View {
        GeometryReader { geometry in
            let cardWidth = min(300, max(224, geometry.size.width * 0.76))
            ScrollView(.horizontal) {
                LazyHStack(spacing: 14) {
                    ForEach(Array(restaurants.enumerated()), id: \.offset) { _, kitchen in
                        let card = kitchenCard(kitchen, width: cardWidth)
                        if reduceMotion { card }
                        else { card.scrollTransition(.animated(.spring(duration: 0.34)), axis: .horizontal) { content, phase in
                            content.scaleEffect(phase.isIdentity ? 1 : 0.95).opacity(phase.isIdentity ? 1 : 0.82)
                        } }
                    }
                }.scrollTargetLayout().padding(.horizontal, 10).padding(.vertical, 6)
            }.scrollIndicators(.hidden).scrollTargetBehavior(.viewAligned)
        }
        .frame(height: 266)
        .accessibilityLabel("Available kitchens. Swipe horizontally to browse.")
    }

    private func kitchenCard(_ kitchen: [String: Any], width: CGFloat) -> some View {
        Button { Task { await open(kitchen) } } label: {
            VStack(alignment: .leading, spacing: 0) {
                foodPhoto(imageKey(for: kitchen))
                    .frame(height: 158).frame(maxWidth: .infinity).clipped()
                    .overlay(alignment: .bottomLeading) {
                        Text(str(kitchen["cuisine"]))
                            .font(.caption.weight(.semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(.black.opacity(0.48), in: Capsule()).padding(10)
                    }
                VStack(alignment: .leading, spacing: 4) {
                    Text(str(kitchen["name"])).font(.headline.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                    Text(str(kitchen["address"])).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    let available = items.filter { str($0["restaurant_id"]) == str(kitchen["id"]) }.count
                    Text("\(available) published dishes").font(.caption).foregroundStyle(CenaStyle.maroon).lineLimit(1)
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(width: width).cenaCardBackground(.white, outline: .black.opacity(0.05))
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(str(kitchen["name"])), \(str(kitchen["cuisine"])), view menu")
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
                if let selected = slot, let cutoff = timestamp(selected["cutoff_at"]), Calendar.current.isDateInToday(cutoff) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let remaining = max(0, Int(cutoff.timeIntervalSince(context.date)))
                        Label(remaining == 0 ? "Ordering closed for this window" : "Order cutoff in \(remaining / 60):\(String(format: "%02d", remaining % 60))", systemImage: "timer")
                            .font(.caption.weight(.semibold)).foregroundStyle(remaining == 0 ? .red : .green)
                            .padding(.horizontal, 11).padding(.vertical, 7)
                            .overlay { Capsule().stroke(remaining == 0 ? Color.red.opacity(0.65) : Color.green.opacity(0.75), lineWidth: 1) }
                    }
                }
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
        }.scrollContentBackground(.hidden)
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
        }.navigationTitle("Pickup checkout")
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
        }.scrollContentBackground(.hidden).navigationTitle("Your orders").task { await loadHistory() }
    }
    @State private var history: [[String: Any]] = []
    private func orderConfirmation(_ id: String) -> some View {
        VStack(spacing: 16) { Image(systemName: "checkmark.circle.fill").font(.system(size: 58)).foregroundStyle(.green); Text("Order placed").font(.largeTitle.bold()).fontDesign(.default).foregroundStyle(CenaStyle.maroon); Text("Order \(id.prefix(8).uppercased())").font(.headline); Text("Your kitchen has received it. Pickup and payment details are available in Orders.").multilineTextAlignment(.center).foregroundStyle(.secondary); Button("Back to kitchens") { orderNumber = nil; restaurant = nil; cart.removeAll(); slots = []; slot = nil; tab = 0 }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon) }.padding(28).transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.97)))
    }
    private func tabButton(_ title: String, icon: String, value: Int) -> some View { Button { tab = value; restaurant = nil } label: { Label(title, systemImage: icon).frame(maxWidth: .infinity).foregroundStyle(tab == value ? CenaStyle.maroon : .secondary) } }
    private func load() async {
        guard api.configured else { message = "Supabase URL and public anon key are required for live menus, availability, and orders."; return }
        do { restaurants = try await api.rows("restaurants", query: "select=id,slug,name,cuisine,description,address,timezone,curbside_enabled&active=eq.true&order=name.asc"); items = try await api.rows("catalog_items", query: "select=id,restaurant_id,name,description,price_cents,regular_price_cents,equipment,allergens,published_steps,image_key,category,prep_minutes&active=eq.true&published_at=not.is.null&order=category.asc,name.asc") }
        catch { message = error.localizedDescription }
    }
    private func open(_ r: [String: Any]) async {
        restaurant = r; slots = []; slot = nil; curbside = false
        do {
            let all = try await api.rows("pickup_slots", query: "select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,slot_item_inventory(slot_id,item_id,available_qty,reserved_qty)&restaurant_id=eq.\(str(r["id"]))&active=eq.true&starts_at=gt.\(isoNow)&cutoff_at=gt.\(isoNow)&order=starts_at.asc")
            let liveIDs = Set(items.filter { str($0["restaurant_id"]) == str(r["id"]) }.map { str($0["id"]) })
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
