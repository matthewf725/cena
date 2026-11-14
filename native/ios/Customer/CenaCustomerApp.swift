import SwiftUI
import UIKit
import CoreLocation

@main struct CenaCustomerApp: App {
    var body: some Scene { WindowGroup { CustomerHome().tint(CenaStyle.maroon) } }
}

struct CustomerHome: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
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
    @State private var cartItemDetails: [String: [String: Any]] = [:]
    @State private var cartRestaurantID: String?
    @State private var cartRestaurantInfo: [String: Any]?
    @State private var cartPickupSlot: [String: Any]?
    @State private var cartQuantityLimit: [String: Int] = [:]
    @State private var checkoutVisible = false
    @State private var tab = 0
    @State private var email = "", code = "", phone = ""
    @State private var pickupAreaLabel = "San Francisco pickup area"
    @State private var pickupLatitude = 37.77, pickupLongitude = -122.42
    @State private var locationQuery = "", showLocationEditor = false, locationBusy = false
    @State private var curbside = false, vehicleMake = "", vehicleModel = "", vehicleColor = ""
    @State private var codeSent = false
    @State private var idempotencyKey = UserDefaults.standard.string(forKey: "cena.checkout.idempotencyKey") ?? UUID().uuidString
    @State private var pendingCheckoutID = UserDefaults.standard.string(forKey: "cena.checkout.pendingOrderID")
    @State private var pendingCheckoutURL: String?
    @State private var pendingCheckoutOwnerID = UserDefaults.standard.string(forKey: "cena.checkout.pendingOwnerID")
    @State private var paymentStatus = "pending"
    @State private var paymentMessage: String?
    @State private var paymentCheckBusy = false
    @State private var confirmCancelCheckout = false
    @State private var busy = false
    @State private var message: String?
    @State private var orderNumber: String?
    @State private var profileName = "", profilePhone = "", profileEquipment: [String] = []
    @State private var profileLoading = false, profileSaving = false, profileEditRevision = 0
    @State private var profileNotice: String?
    private var subtotal: Int { cart.reduce(0) { sum, entry in sum + entry.value * (cartItemDetails[entry.key].map { int($0["price_cents"]) } ?? 0) } }
    private var cartCount: Int { cart.values.reduce(0, +) }
    private var checkoutRestaurant: [String: Any]? { cartRestaurantInfo ?? restaurant }
    private var checkoutSlot: [String: Any]? { cartPickupSlot ?? slot }
    private var restaurantItems: [[String: Any]] {
        guard let slot else { return [] }
        let availability = Dictionary(uniqueKeysWithValues: inventory(slot).map { (str($0["item_id"]), max(0, int($0["available_qty"]) - int($0["reserved_qty"]))) })
        return items.filter { str($0["restaurant_id"]) == str(restaurant?["id"]) && availability[str($0["id"]), default: 0] > 0 }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let orderNumber { orderConfirmation(orderNumber).transition(smoothTransition) }
                else if tab == 3 { accountScreen.transition(smoothTransition) }
                else if let pendingCheckoutID { paymentPendingScreen(pendingCheckoutID).transition(smoothTransition) }
                else if tab == 1 { orderHistory.transition(smoothTransition) }
                else if tab == 2 { bagScreen.transition(smoothTransition) }
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
            .toolbar {
                if restaurant != nil { ToolbarItem(placement: .topBarLeading) { Button("Kitchens") { self.restaurant = nil; slots = []; slot = nil } } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { locationQuery = pickupAreaLabel; showLocationEditor = true } label: { Image(systemName: "mappin.and.ellipse").font(.title3).accessibilityLabel("Set pickup area") }
                    Button { tab = 3 } label: { Image(systemName: "person.crop.circle").font(.title3).accessibilityLabel("Profile") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if orderNumber == nil && pendingCheckoutID == nil && !checkoutVisible {
                    HStack { tabButton("Discover", icon: "fork.knife", value: 0); tabButton("Orders", icon: "clock.arrow.circlepath", value: 1); tabButton("Bag", icon: "bag", value: 2) }
                        .padding(.vertical, 10).background(.white)
                }
            }
            .background(CenaStyle.cream)
            .overlay(alignment: .top) { if let message { CenaNotice(message: message) { self.message = nil }.padding(.horizontal, 14).padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)) } }
            .animation(.easeInOut(duration: 0.2), value: message)
            .task {
                restoreBag()
                restoreIdempotencyKey()
                restorePendingCheckoutForCurrentIdentity(allowLegacyClaim: true)
                await load()
                if pendingCheckoutID != nil { await refreshPendingCheckout() }
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active, pendingCheckoutID != nil { Task { await refreshPendingCheckout() } } }
            .sheet(isPresented: $showLocationEditor) { locationEditor }
        }
    }

    private var homeScreen: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Dinner, made\na little easier.").font(.largeTitle.weight(.bold)).fontDesign(.default).foregroundStyle(CenaStyle.maroon)
                    Text("Local meal kits, prepared by neighborhood kitchens.").foregroundStyle(.secondary)
                    if !api.configured { Label("Connect Supabase to browse live menus.", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
                    else { Text("Approximate miles from \(pickupAreaLabel).").font(.caption).foregroundStyle(.secondary) }
                }.padding(.horizontal, 20).padding(.top, 12)
                recentRail
                mealExploreRail
                restaurantRail(title: "Near you", subtitle: "Using \(pickupAreaLabel) as the distance reference.", values: nearbyRestaurants)
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

    private var locationEditor: some View {
        NavigationStack {
            Form {
                Section("Pickup area") {
                    TextField("Address, neighborhood, or ZIP", text: $locationQuery).textInputAutocapitalization(.words)
                    Button(locationBusy ? "Finding area…" : "Use this pickup area") { Task { await setPickupArea() } }
                        .disabled(locationBusy || locationQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section {
                    Text("Use a neighborhood or ZIP for privacy. Cena receives only coordinates rounded to about 2 decimal places for this discovery request; your location is not saved.").font(.caption).foregroundStyle(.secondary)
                    Button("Use San Francisco pickup area") {
                        pickupLatitude = 37.77; pickupLongitude = -122.42; pickupAreaLabel = "San Francisco pickup area"; showLocationEditor = false
                        Task { await load() }
                    }
                }
            }.navigationTitle("Pickup area").toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showLocationEditor = false } } }
        }.presentationDetents([.medium, .large])
    }

    private func setPickupArea() async {
        locationBusy = true; defer { locationBusy = false }
        do {
            let placemarks = try await CLGeocoder().geocodeAddressString(locationQuery)
            guard let placemark = placemarks.first, let coordinate = placemark.location?.coordinate else { throw CenaBackendError.server("We couldn’t find that pickup area. Try a nearby city, neighborhood, or ZIP.") }
            pickupLatitude = (coordinate.latitude * 100).rounded() / 100
            pickupLongitude = (coordinate.longitude * 100).rounded() / 100
            let locality = placemark.locality ?? placemark.subAdministrativeArea ?? "Pickup area"
            pickupAreaLabel = [locality, placemark.administrativeArea].compactMap { $0 }.joined(separator: ", ")
            showLocationEditor = false
            await load()
        } catch { message = error.localizedDescription }
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
            Text("Recent meal kits").font(.title2.weight(.bold)).padding(.horizontal, 20)
            if exploreMeals.isEmpty { Text(api.signedIn ? "Meal kits from your orders will appear here." : "Sign in during checkout to see meal kits from your orders.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20) }
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
                    if meal["historical_order"] as? Bool == true { Text("Last paid $\(money(int(meal["price_cents"])))").font(.subheadline.weight(.semibold)).foregroundStyle(CenaStyle.maroon) }
                    else { priceComparison(meal) }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(width: width).cenaCardBackground(.white, outline: .black.opacity(0.05))
        }.buttonStyle(.plain).accessibilityLabel(meal["historical_order"] as? Bool == true ? "\(str(meal["name"])), from \(str(kitchen["name"])), last paid \(money(int(meal["price_cents"]))) dollars" : "\(str(meal["name"])), from \(str(kitchen["name"])), \(money(int(meal["price_cents"]))) dollars")
    }

    @ViewBuilder private func cutoffBadge(_ slot: [String: Any]?) -> some View {
        if let slot, let cutoff = timestamp(slot["cutoff_at"]) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = max(0, Int(cutoff.timeIntervalSince(context.date)))
                let hours = remaining / 3600, minutes = (remaining % 3600) / 60, seconds = remaining % 60
                let today = (timestamp(slot["starts_at"]).map { Calendar.current.isDateInToday($0) }) ?? false
                let title = today ? "Order cutoff for pickup today · \(String(format: "%02d:%02d:%02d", hours, minutes, seconds))" : "Order cutoff · \(String(format: "%02d:%02d:%02d", hours, minutes, seconds))"
                Text(remaining == 0 ? "Ordering closed" : title)
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
                    Picker("Pickup window", selection: Binding(get: { str(slot?["id"]) }, set: { id in slot = slots.first { str($0["id"]) == id }; if cartRestaurantID == str(restaurant?["id"]) { cartPickupSlot = slot; persistBag() }; idempotencyKey = UUID().uuidString })) {
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
                            HStack(spacing: 8) { priceComparison(item); Text("· \(str(item["prep_minutes"])) min").font(.caption).foregroundStyle(.secondary) }
                            if let steps = item["published_steps"] as? [String], !steps.isEmpty { Text(steps.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        Button { if count == 0 { addToBag(item) } else { setBagQuantity(id, count - 1) }; idempotencyKey = UUID().uuidString } label: {
                            Text(count == 0 ? "Add" : "Added").font(.subheadline.weight(.bold)).padding(.horizontal, 13).padding(.vertical, 8).background(count == 0 ? CenaStyle.maroon : .gray.opacity(0.15)).foregroundStyle(count == 0 ? .white : .primary).clipShape(Capsule())
                        }
                    }.padding(14).cenaCardBackground(.white).padding(.vertical, 4)
                }
            }
            if !cart.isEmpty {
                Section("Your bag · $\(money(subtotal))") {
                    ForEach(Array(cart.keys.sorted()), id: \.self) { id in
                        if let item = cartItemDetails[id] ?? items.first(where: { str($0["id"]) == id }) {
                            let maxQty = min(50, inventory(slot ?? [:]).filter { str($0["item_id"]) == id }.map { max(0, int($0["available_qty"]) - int($0["reserved_qty"])) }.first ?? 1)
                            HStack { Text(str(item["name"])); Spacer(); Stepper("\(cart[id, default: 0])", value: Binding(get: { cart[id, default: 0] }, set: { setBagQuantity(id, $0); idempotencyKey = UUID().uuidString }), in: 1...max(1, maxQty)).labelsHidden(); Text("×\(cart[id, default: 0])") }
                        }
                    }
                    NavigationLink { checkoutScreen.onAppear { checkoutVisible = true }.onDisappear { checkoutVisible = false } } label: { Label("Continue to pickup", systemImage: "arrow.right").fontWeight(.semibold).foregroundStyle(CenaStyle.maroon) }
                        .disabled(checkoutSlot == nil || !api.paymentGatewayConfigured)
                    if !api.paymentGatewayConfigured { Text("Cena’s payment service is not configured.").font(.caption).foregroundStyle(.orange) }
                }
            }
        }.scrollContentBackground(.hidden).scrollIndicators(.hidden)
    }

    private var checkoutScreen: some View {
        Form {
            Section("Pickup details") {
                Text(str(checkoutRestaurant?["name"]))
                Text(checkoutSlot.map(dateRange) ?? "Choose an available pickup window")
                Text("Pay securely in Cena to place your order.").foregroundStyle(.secondary)
                if checkoutRestaurant?["curbside_enabled"] as? Bool == true {
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
            Section("Order summary") { ForEach(Array(cart.keys.sorted()), id: \.self) { id in if let x = cartItemDetails[id] { HStack { Text("\(cart[id, default: 0]) × \(str(x["name"]))"); Spacer(); Text("$\(money(int(x["price_cents"]) * cart[id, default: 0]))") } } }; HStack { Text("Subtotal").fontWeight(.bold); Spacer(); Text("$\(money(subtotal))").fontWeight(.bold) } }
            Section {
                Button(busy ? "Please wait…" : (api.signedIn ? "Pay in Cena" : (codeSent ? "Verify code & pay in Cena" : "Email me a sign-in code"))) { Task { await place() } }
                    .disabled(busy || (!api.signedIn && (email.isEmpty || (codeSent && code.isEmpty))) || !api.paymentGatewayConfigured)
                if !api.paymentGatewayConfigured { Text("Cena’s payment service is not configured. Checkout is unavailable.").font(.caption).foregroundStyle(.orange) }
            }
        }.scrollIndicators(.hidden).navigationTitle("Pickup checkout")
    }

    private func paymentPendingScreen(_ orderID: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: "creditcard.circle").font(.system(size: 46)).foregroundStyle(CenaStyle.maroon)
            Text("Finish payment in Cena").font(.title2.bold()).foregroundStyle(CenaStyle.maroon)
            Text("Your bag is saved for order \(orderID.prefix(8).uppercased()). Return here after paying. Cena will confirm the payment with the provider before marking the order complete.").font(.body).foregroundStyle(.secondary)
            if let paymentMessage { Text(paymentMessage).font(.subheadline).foregroundStyle(paymentStatus == "paid" ? .green : .secondary) }
            if paymentCheckBusy { ProgressView("Checking payment…") }
            if pendingCheckoutURL != nil {
                Button("Continue to secure Stripe checkout") { Task { await openPendingCheckout() } }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon)
            }
            Button("Check payment status") { Task { await refreshPendingCheckout() } }.buttonStyle(.bordered)
            if !["expired", "failed", "cancelled", "paid", "refunded"].contains(paymentStatus.lowercased()) {
                if confirmCancelCheckout {
                    HStack { Button("Keep checkout") { confirmCancelCheckout = false }; Button("Confirm cancel") { Task { await cancelPendingCheckout() } }.foregroundStyle(.red) }
                } else { Button("Cancel checkout") { confirmCancelCheckout = true }.font(.caption).foregroundStyle(.secondary) }
            }
            if ["expired", "failed", "cancelled"].contains(paymentStatus.lowercased()) {
                Button("Start a new checkout") { clearPendingCheckout(resetIdempotency: true); tab = 2 }.foregroundStyle(CenaStyle.maroon)
            }
        }.padding(24).frame(maxWidth: .infinity, alignment: .leading).navigationTitle("Payment")
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

    private var bagScreen: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text("Your bag").font(.largeTitle.bold()).foregroundStyle(CenaStyle.maroon).padding(.horizontal, 20).padding(.top, 12)
                if cart.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your bag is empty").font(.title3.weight(.semibold))
                        Text("Explore meal kits and add items from one kitchen to get started.").font(.subheadline).foregroundStyle(.secondary)
                        Button("Explore kitchens") { tab = 0; restaurant = nil }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon).padding(.top, 4)
                    }.padding(18).cenaCardBackground(.white).padding(.horizontal, 20)
                } else {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(str(cartRestaurantInfo?["name"])).font(.headline)
                        Text(str(cartRestaurantInfo?["address"])).font(.subheadline).foregroundStyle(.secondary)
                        if let pickup = cartPickupSlot { Text(dateRange(pickup)).font(.caption).foregroundStyle(CenaStyle.maroon) }
                        else { Text("Choose a pickup window from this kitchen’s menu.").font(.caption).foregroundStyle(.secondary) }
                    }.padding(16).cenaCardBackground(.white).padding(.horizontal, 20)

                    ForEach(Array(cart.keys.sorted()), id: \.self) { id in
                        if let item = cartItemDetails[id] {
                            HStack(alignment: .top, spacing: 12) {
                                foodPhoto(imageKey(for: item)).frame(width: 82, height: 88).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(str(item["name"])).font(.headline).lineLimit(2)
                                    priceComparison(item)
                                    HStack(spacing: 12) {
                                        Button { setBagQuantity(id, cart[id, default: 0] - 1) } label: { Image(systemName: cart[id, default: 0] == 1 ? "trash" : "minus").frame(width: 34, height: 34).background(CenaStyle.cream, in: Circle()) }.accessibilityLabel(cart[id, default: 0] == 1 ? "Remove \(str(item["name"]))" : "Decrease quantity")
                                        Text("\(cart[id, default: 0])").font(.subheadline.weight(.semibold)).monospacedDigit()
                                        Button { setBagQuantity(id, cart[id, default: 0] + 1) } label: { Image(systemName: "plus").frame(width: 34, height: 34).background(CenaStyle.cream, in: Circle()) }.disabled(cart[id, default: 0] >= cartQuantityLimit[id, default: 50]).accessibilityLabel("Increase quantity")
                                        Spacer()
                                        Text("$\(money(int(item["price_cents"]) * cart[id, default: 0]))").font(.subheadline.weight(.semibold))
                                    }.buttonStyle(.plain).foregroundStyle(CenaStyle.maroon)
                                }
                                Spacer(minLength: 0)
                            }.padding(14).cenaCardBackground(.white).padding(.horizontal, 20)
                        }
                    }
                    VStack(spacing: 12) {
                        HStack { Text("Kit subtotal").font(.headline); Spacer(); Text("$\(money(subtotal))").font(.headline) }
                        Text("The subtotal uses kit prices. Pay securely in Cena to place your order.").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                        NavigationLink { checkoutScreen.onAppear { checkoutVisible = true }.onDisappear { checkoutVisible = false } } label: { Label("Continue to pickup", systemImage: "arrow.right").fontWeight(.semibold).frame(maxWidth: .infinity).padding(14).background(CenaStyle.maroon, in: Capsule()).foregroundStyle(.white) }
                            .disabled(cartPickupSlot == nil || !api.paymentGatewayConfigured)
                        if !api.paymentGatewayConfigured { Text("Checkout requires Cena’s payment service.").font(.caption).foregroundStyle(.orange) }
                        Button("Remove all items") { clearBag() }.font(.subheadline).foregroundStyle(.secondary)
                    }.padding(16).cenaCardBackground(.white).padding(.horizontal, 20)
                }
            }.padding(.bottom, 24)
        }.scrollIndicators(.hidden).navigationTitle("Bag")
    }

    private var accountScreen: some View {
        Form {
            Section {
                Text("Your Cena account").font(.title2.bold()).foregroundStyle(CenaStyle.maroon)
                Text(api.signedIn ? "Signed in with your customer account." : "Sign in with an email code to link orders and recent kitchens.").font(.subheadline).foregroundStyle(.secondary)
            }
            if !api.signedIn {
                Section("Email sign in") {
                    TextField("Email address", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress)
                    if codeSent { TextField("One-time code", text: $code).keyboardType(.numberPad) }
                    Button(codeSent ? "Verify code" : "Send sign-in code") { Task { await signInFromProfile() } }.disabled(busy || email.isEmpty || (codeSent && code.isEmpty))
                }
            } else {
                Section("Account") { LabeledContent("Email", value: profileUserEmail ?? "Signed-in account") }
                Section("Personal details") {
                    TextField("Display name", text: Binding(get: { profileName }, set: { profileName = $0; profileEditRevision += 1 })).textContentType(.name)
                    TextField("Phone", text: Binding(get: { profilePhone }, set: { profilePhone = $0; profileEditRevision += 1 })).keyboardType(.phonePad).textContentType(.telephoneNumber)
                }
                Section("Kitchen equipment") {
                    ForEach(["Oven", "Stovetop", "Microwave", "Air fryer"], id: \.self) { equipment in
                        Toggle(equipment, isOn: Binding(get: { profileEquipment.contains(equipment) }, set: { selected in
                            if selected && !profileEquipment.contains(equipment) { profileEquipment.append(equipment) }
                            if !selected { profileEquipment.removeAll { $0 == equipment } }
                            profileEditRevision += 1
                        }))
                    }
                }
                Section {
                    if profileLoading { ProgressView("Loading profile…") }
                    if let profileNotice { Text(profileNotice).font(.caption).foregroundStyle(profileNotice.hasPrefix("Couldn’t") ? .red : .green) }
                    Button(profileSaving ? "Saving…" : "Save profile") { Task { await saveProfile() } }.disabled(profileSaving || profileLoading)
                }
                Section("Your orders") { Button("View order history") { tab = 1 }.foregroundStyle(CenaStyle.maroon) }
                if pendingCheckoutID != nil { Section("Pending payment") { Button("Return to payment") { tab = 2 }.foregroundStyle(CenaStyle.maroon) } }
                Section { Button("Sign out", role: .destructive) {
                    persistBag(); api.signOut(); cart = [:]; cartItemDetails = [:]; cartQuantityLimit = [:]; cartRestaurantID = nil; cartRestaurantInfo = nil; cartPickupSlot = nil; restoreBag(); restoreIdempotencyKey()
                    recentRestaurants = []; recentRestaurantIDs = []; exploreMeals = []; history = []; recentHistoryUnavailable = false; codeSent = false
                    profileName = ""; profilePhone = ""; profileEquipment = []; profileNotice = nil; profileEditRevision += 1
                } }
            }
        }.scrollContentBackground(.hidden).scrollIndicators(.hidden).navigationTitle("Profile").task(id: api.signedIn) { if api.signedIn { await loadProfile() } }
    }

    private func signInFromProfile() async {
        busy = true; defer { busy = false }
        do {
            if !codeSent { try await api.sendCode(email: email); codeSent = true; message = "Check your email for the one-time sign-in code."; return }
            try await api.verifyCode(email: email, code: code)
            // The signed-in account owns its own saved bag. Preserve the guest bag under
            // its separate key and restore this account's snapshot after authentication.
            cart = [:]; cartItemDetails = [:]; cartQuantityLimit = [:]; cartRestaurantID = nil; cartRestaurantInfo = nil; cartPickupSlot = nil; restoreBag()
            restoreIdempotencyKey()
            restorePendingCheckoutForCurrentIdentity(allowLegacyClaim: false)
            codeSent = false; code = ""; message = "You’re signed in."; await load(); await loadHistory(); await loadProfile()
            if pendingCheckoutID != nil { tab = 2; await refreshPendingCheckout() }
        } catch { message = error.localizedDescription }
    }

    private var authClaims: [String: Any] {
        guard let token = api.accessToken else { return [:] }
        let segments = token.split(separator: ".")
        guard segments.count > 1 else { return [:] }
        var payload = String(segments[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return claims
    }
    private var profileUserID: String? { authClaims["sub"] as? String }
    private var profileUserEmail: String? { authClaims["email"] as? String }

    private func loadProfile() async {
        guard api.signedIn, !profileLoading else { return }
        guard let userID = profileUserID else { profileNotice = "Couldn’t read your account. Sign in again to load your profile."; return }
        profileLoading = true; defer { profileLoading = false }
        let revision = profileEditRevision
        do {
            let rows = try await api.rows("profiles", query: "select=id,display_name,phone,equipment&id=eq.\(userID)&limit=1", authenticated: true)
            guard revision == profileEditRevision else { return }
            if let profile = rows.first {
                profileName = str(profile["display_name"])
                profilePhone = str(profile["phone"])
                profileEquipment = profile["equipment"] as? [String] ?? []
            }
            profileNotice = nil
        } catch { profileNotice = "Couldn’t load profile: \(error.localizedDescription)" }
    }

    private func saveProfile() async {
        guard api.signedIn, let userID = profileUserID else { profileNotice = "Sign in again to save your profile."; return }
        profileSaving = true; defer { profileSaving = false }
        do {
            let trimmedPhone = profilePhone.trimmingCharacters(in: .whitespacesAndNewlines)
            let phoneValue: Any = trimmedPhone.isEmpty ? NSNull() : trimmedPhone
            _ = try await api.upsert("profiles", query: "on_conflict=id", body: [
                "id": userID,
                "display_name": profileName.trimmingCharacters(in: .whitespacesAndNewlines),
                "phone": phoneValue,
                "equipment": profileEquipment
            ])
            profileEditRevision += 1
            profileNotice = "Profile saved."
        } catch { profileNotice = "Couldn’t save profile: \(error.localizedDescription)" }
    }


    private func addToBag(_ item: [String: Any]) {
        guard pendingCheckoutID == nil else { message = "Finish or cancel the pending checkout before changing your bag."; return }
        let selectedRestaurantID = str(restaurant?["id"])
        if let cartRestaurantID, cartRestaurantID != selectedRestaurantID {
            message = "Your bag is for \(str(cartRestaurantInfo?["name"])) only. Remove those items before starting an order from another kitchen."
            return
        }
        guard let slot else { message = "Choose an available pickup window before adding a kit."; return }
        let remaining = inventory(slot).first { str($0["item_id"]) == str(item["id"]) }.map { max(0, int($0["available_qty"]) - int($0["reserved_qty"])) } ?? 0
        guard remaining > cart[str(item["id"]), default: 0] else { message = "That item is no longer available in this quantity."; return }
        cartRestaurantID = selectedRestaurantID; cartRestaurantInfo = restaurant; cartPickupSlot = slot
        let id = str(item["id"]); cartItemDetails[id] = item; cartQuantityLimit[id] = remaining
        cart[id, default: 0] += 1
        persistBag()
    }

    private func setBagQuantity(_ id: String, _ quantity: Int) {
        guard pendingCheckoutID == nil else { message = "Your bag is locked while payment is pending."; return }
        if quantity <= 0 { cart.removeValue(forKey: id); cartItemDetails.removeValue(forKey: id); cartQuantityLimit.removeValue(forKey: id) }
        else { cart[id] = min(quantity, cartQuantityLimit[id, default: 50]) }
        if cart.isEmpty { cartRestaurantID = nil; cartRestaurantInfo = nil; cartPickupSlot = nil }
        persistBag()
    }

    private func persistBag() {
        guard pendingCheckoutID == nil || pendingCheckoutOwnerID == profileUserID else { return }
        let snapshot: [String: Any] = ["cart": cart, "details": cartItemDetails, "restaurantID": cartRestaurantID as Any? ?? NSNull(), "restaurant": cartRestaurantInfo as Any? ?? NSNull(), "slot": cartPickupSlot as Any? ?? NSNull(), "limits": cartQuantityLimit]
        guard JSONSerialization.isValidJSONObject(snapshot), let data = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
        UserDefaults.standard.set(data, forKey: bagStorageKey)
    }
    private func restoreBag() {
        guard let data = UserDefaults.standard.data(forKey: bagStorageKey),
              let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        cart = snapshot["cart"] as? [String: Int] ?? [:]
        cartItemDetails = snapshot["details"] as? [String: [String: Any]] ?? [:]
        cartRestaurantID = snapshot["restaurantID"] as? String
        cartRestaurantInfo = snapshot["restaurant"] as? [String: Any]
        cartPickupSlot = snapshot["slot"] as? [String: Any]
        cartQuantityLimit = snapshot["limits"] as? [String: Int] ?? [:]
    }
    private var bagStorageKey: String { "cena.customer.bag.\(profileUserID ?? "anonymous")" }
    private func clearBag() { cart.removeAll(); cartItemDetails.removeAll(); cartQuantityLimit.removeAll(); cartRestaurantID = nil; cartRestaurantInfo = nil; cartPickupSlot = nil; UserDefaults.standard.removeObject(forKey: bagStorageKey) }
    private var idempotencyStorageKey: String { "cena.checkout.idempotencyKey.\(profileUserID ?? "anonymous")" }
    private func restoreIdempotencyKey() {
        idempotencyKey = UserDefaults.standard.string(forKey: idempotencyStorageKey) ?? UUID().uuidString
    }
    private func pendingIDKey(_ owner: String) -> String { "cena.checkout.pending.\(owner).orderID" }
    private func pendingURLKey(_ owner: String) -> String { "cena.checkout.pending.\(owner).url" }
    private func restorePendingCheckoutForCurrentIdentity(allowLegacyClaim: Bool) {
        let defaults = UserDefaults.standard
        guard let owner = pendingCheckoutOwnerID else {
            if allowLegacyClaim, let userID = profileUserID, let legacyID = defaults.string(forKey: "cena.checkout.pendingOrderID") {
                pendingCheckoutOwnerID = userID
                defaults.set(userID, forKey: "cena.checkout.pendingOwnerID")
                defaults.set(legacyID, forKey: pendingIDKey(userID))
                if let legacyURL = defaults.string(forKey: "cena.checkout.pendingURL") { defaults.set(legacyURL, forKey: pendingURLKey(userID)) }
                defaults.removeObject(forKey: "cena.checkout.pendingURL")
                pendingCheckoutID = legacyID
                pendingCheckoutURL = defaults.string(forKey: pendingURLKey(userID))
                return
            }
            pendingCheckoutURL = nil
            defaults.removeObject(forKey: "cena.checkout.pendingURL")
            return
        }
        if let scopedID = defaults.string(forKey: pendingIDKey(owner)) { pendingCheckoutID = scopedID }
        guard owner == profileUserID else { pendingCheckoutURL = nil; return }
        if defaults.string(forKey: pendingIDKey(owner)) == nil, let legacyID = defaults.string(forKey: "cena.checkout.pendingOrderID") {
            defaults.set(legacyID, forKey: pendingIDKey(owner))
            pendingCheckoutID = legacyID
            if let legacyURL = defaults.string(forKey: "cena.checkout.pendingURL") { defaults.set(legacyURL, forKey: pendingURLKey(owner)) }
            defaults.removeObject(forKey: "cena.checkout.pendingURL")
        }
        pendingCheckoutURL = defaults.string(forKey: pendingURLKey(owner))
    }

    private func orderConfirmation(_ id: String) -> some View {
        VStack(spacing: 16) { Image(systemName: "checkmark.circle.fill").font(.system(size: 58)).foregroundStyle(.green); Text("Order placed").font(.largeTitle.bold()).fontDesign(.default).foregroundStyle(CenaStyle.maroon); Text("Order \(id.prefix(8).uppercased())").font(.headline); Text("Your kitchen has received it. Pickup and payment details are available in Orders.").multilineTextAlignment(.center).foregroundStyle(.secondary); Button("Back to kitchens") { orderNumber = nil; restaurant = nil; clearBag(); slots = []; slot = nil; tab = 0; Task { await load() } }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon) }.padding(28).transition(reduceMotion ? .identity : .opacity.combined(with: .scale(scale: 0.97)))
    }
    private func tabButton(_ title: String, icon: String, value: Int) -> some View {
        Button { tab = value; if value == 0 { restaurant = nil } } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 18, weight: .semibold))
                    .overlay(alignment: .topTrailing) {
                        if value == 2 && cartCount > 0 {
                            Text(cartCount > 99 ? "99+" : "\(cartCount)").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 5).padding(.vertical, 2).background(CenaStyle.maroon, in: Capsule()).offset(x: 14, y: -8)
                        }
                    }
                Text(title).font(.caption2.weight(tab == value ? .semibold : .regular))
            }.frame(maxWidth: .infinity).foregroundStyle(tab == value ? CenaStyle.maroon : .secondary).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityLabel(value == 2 && cartCount > 0 ? "Bag, \(cartCount) items" : title)
    }
    private func load() async {
        guard api.configured else { message = "Supabase URL and public anon key are required for live discovery and checkout."; return }
        nextFeedCursor = nil; moreError = nil
        do {
            if api.signedIn {
                do {
                    let priorOrders = try await api.rows("orders", query: "select=restaurant_id,created_at,restaurants(id,slug,name,cuisine,image_key,description,address,timezone,curbside_enabled),order_items(item_id,name_snapshot,quantity,unit_price_cents)&order=created_at.desc&limit=40", authenticated: true)
                    recentHistoryUnavailable = false
                    var seen = Set<String>()
                    var seenMeals = Set<String>()
                    recentRestaurantIDs = priorOrders.compactMap { row -> String? in
                        let id = str(row["restaurant_id"])
                        guard !id.isEmpty, seen.insert(id).inserted else { return nil }
                        return id
                    }
                    exploreMeals = priorOrders.flatMap { order -> [[String: Any]] in
                        guard let kitchen = order["restaurants"] as? [String: Any] else { return [] }
                        return ((order["order_items"] as? [[String: Any]]) ?? []).compactMap { bought -> [String: Any]? in
                            let itemID = str(bought["item_id"])
                            guard !itemID.isEmpty, seenMeals.insert(itemID).inserted else { return nil }
                            let meal: [String: Any] = ["id": itemID, "name": str(bought["name_snapshot"]), "price_cents": int(bought["unit_price_cents"]), "historical_order": true]
                            return ["meal": meal, "restaurant": kitchen]
                        }
                    }.prefix(20).map { $0 }
                } catch { recentRestaurantIDs = []; exploreMeals = []; recentHistoryUnavailable = true }
            } else { recentRestaurantIDs = []; recentHistoryUnavailable = false; exploreMeals = [] }
            let feed = try await fetchDiscovery(after: nil)
            recentRestaurants = recentRestaurantIDs.isEmpty ? [] : (feed["recent"] as? [[String: Any]] ?? [])
            nearbyRestaurants = feed["nearby"] as? [[String: Any]] ?? []
            categoryRails = validCategories(feed["categories"] as? [[String: Any]] ?? [])
            nextFeedCursor = feed["next_cursor"] as? String
            moreError = nil
        } catch { message = error.localizedDescription }
    }

    private func fetchDiscovery(after cursor: String?) async throws -> [String: Any] {
        let response = try await api.rpc("discover_pickup_feed", body: [
            "p_latitude": pickupLatitude, "p_longitude": pickupLongitude,
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
            items = try await api.rows("catalog_items", query: "select=id,restaurant_id,name,description,price_cents,prepared_meal_total_cents,equipment,allergens,published_steps,image_key,category,prep_minutes&restaurant_id=eq.\(str(r["id"]))&active=eq.true&published_at=not.is.null&order=category.asc,name.asc")
            let all = try await api.rows("pickup_slots", query: "select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count,slot_item_inventory(slot_id,item_id,available_qty,reserved_qty)&restaurant_id=eq.\(str(r["id"]))&active=eq.true&starts_at=gt.\(isoNow)&cutoff_at=gt.\(isoNow)&order=starts_at.asc")
            let liveIDs = Set(items.map { str($0["id"]) })
            let paymentMinimumCutoff = Date().addingTimeInterval(32 * 60)
            slots = all.filter { s in
                guard let cutoff = timestamp(s["cutoff_at"]), cutoff >= paymentMinimumCutoff else { return false }
                return inventory(s).contains { liveIDs.contains(str($0["item_id"])) && int($0["available_qty"]) > int($0["reserved_qty"]) }
            }
            slot = slots.first
            if cartRestaurantID == str(r["id"]) { cartPickupSlot = slot }
        } catch { message = error.localizedDescription }
    }

    private func validatedStripeURL(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https", components.host?.lowercased() == "checkout.stripe.com",
              components.user == nil, components.password == nil else { return nil }
        return url
    }

    private func openPendingCheckout() async {
        guard pendingCheckoutOwnerID == profileUserID, api.signedIn else {
            paymentMessage = "Sign in to the same Cena account that started this checkout before continuing."
            return
        }
        guard let url = validatedStripeURL(pendingCheckoutURL) else {
            paymentMessage = "The payment link is unavailable or not a trusted Stripe Checkout URL. Your bag is still saved."
            return
        }
        let opened = await UIApplication.shared.open(url)
        if !opened { paymentMessage = "Couldn’t open secure checkout. Try again or check payment status." }
    }

    private func refreshPendingCheckout() async {
        guard let orderID = pendingCheckoutID, !paymentCheckBusy else { return }
        guard pendingCheckoutOwnerID == profileUserID, api.signedIn else {
            paymentMessage = "Sign in to the same Cena account that started this checkout to check its status."
            return
        }
        paymentCheckBusy = true; defer { paymentCheckBusy = false }
        do {
            let status = try await api.checkoutStatus(orderID).lowercased()
            paymentStatus = status
            switch status {
            case "paid":
                clearPendingCheckout(resetIdempotency: false)
                clearBag()
                orderNumber = orderID
                paymentMessage = nil
                await load(); await loadHistory()
            case "refunded":
                clearPendingCheckout(resetIdempotency: true)
                tab = 2
                message = "This checkout was refunded. Your bag is still saved if you’d like to place a new order."
                await loadHistory()
            case "expired": paymentMessage = "This checkout expired. Your bag is saved; start a new checkout to try again."
            case "failed", "cancelled": paymentMessage = "This payment wasn’t completed. Your bag is saved; start a new checkout to try again."
            default: paymentMessage = "Payment isn’t confirmed yet. Your bag will stay here until Cena confirms it."
            }
        } catch { paymentMessage = "Couldn’t verify payment yet. Your order and bag remain pending; try again shortly." }
    }

    private func cancelPendingCheckout() async {
        guard let orderID = pendingCheckoutID else { return }
        guard pendingCheckoutOwnerID == profileUserID, api.signedIn else {
            paymentMessage = "Sign in to the same Cena account that started this checkout to cancel it."
            return
        }
        paymentCheckBusy = true; defer { paymentCheckBusy = false; confirmCancelCheckout = false }
        do {
            try await api.cancelCheckout(orderID)
            let status = try await api.checkoutStatus(orderID).lowercased()
            paymentStatus = status
            if status == "paid" { paymentCheckBusy = false; await refreshPendingCheckout() }
            else if status == "refunded" {
                clearPendingCheckout(resetIdempotency: true); tab = 2
                message = "This checkout was refunded. Your bag is still saved if you’d like to place a new order."
                await loadHistory()
            }
            else if ["expired", "failed", "cancelled"].contains(status) {
                clearPendingCheckout(resetIdempotency: true); tab = 2
                message = "Checkout ended. Your bag is still saved if you want to try again."
            } else { paymentMessage = "Cancellation was requested, but Cena hasn’t confirmed a terminal checkout status yet. Your bag remains saved." }
        } catch { paymentMessage = "Couldn’t cancel this checkout: \(error.localizedDescription). Your bag remains saved." }
    }

    private func clearPendingCheckout(resetIdempotency: Bool) {
        let owner = pendingCheckoutOwnerID
        pendingCheckoutID = nil; pendingCheckoutURL = nil; pendingCheckoutOwnerID = nil; paymentStatus = "pending"
        paymentMessage = nil
        if let owner {
            UserDefaults.standard.removeObject(forKey: pendingIDKey(owner))
            UserDefaults.standard.removeObject(forKey: pendingURLKey(owner))
        }
        UserDefaults.standard.removeObject(forKey: "cena.checkout.pendingOrderID")
        UserDefaults.standard.removeObject(forKey: "cena.checkout.pendingURL")
        UserDefaults.standard.removeObject(forKey: "cena.checkout.pendingOwnerID")
        UserDefaults.standard.removeObject(forKey: idempotencyStorageKey)
        if resetIdempotency { idempotencyKey = UUID().uuidString; UserDefaults.standard.set(idempotencyKey, forKey: idempotencyStorageKey) }
    }

    private func place() async {
        guard pendingCheckoutID == nil else { paymentMessage = "Finish or check your pending Cena payment first."; return }
        guard let r = checkoutRestaurant, let s = checkoutSlot, !cart.isEmpty else { message = "Choose a pickup window and add an available item."; return }
        guard api.paymentGatewayConfigured else { message = "Cena’s payment service is not configured. Checkout is unavailable."; return }
        busy = true; defer { busy = false }
        do {
            if !api.signedIn {
                if !codeSent { try await api.sendCode(email: email); codeSent = true; message = "Check your email for the one-time code."; return }
                try await api.verifyCode(email: email, code: code)
                idempotencyKey = UUID().uuidString
            }
            guard profileUserID != nil else { throw CenaBackendError.server("Sign in again before starting payment.") }
            guard let cutoff = timestamp(s["cutoff_at"]), cutoff.timeIntervalSinceNow >= 32 * 60 else {
                throw CenaBackendError.server("This pickup cutoff is too close for secure payment. Choose another pickup window.")
            }
            if curbside && ([vehicleMake, vehicleModel, vehicleColor].contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })) { throw CenaBackendError.server("Enter the vehicle make, model, and color for curbside pickup.") }
            let itemPayload = cart.map { ["item_id": $0.key, "quantity": $0.value] as [String: Any] }
            let vehicle: [String: String] = curbside ? ["make": vehicleMake.trimmingCharacters(in: .whitespacesAndNewlines), "model": vehicleModel.trimmingCharacters(in: .whitespacesAndNewlines), "color": vehicleColor.trimmingCharacters(in: .whitespacesAndNewlines)] : [:]
            persistBag()
            UserDefaults.standard.set(idempotencyKey, forKey: idempotencyStorageKey)
            let response = try await api.createCheckout(["p_restaurant_id": str(r["id"]), "p_slot_id": str(s["id"]), "p_idempotency_key": idempotencyKey, "p_pickup_mode": curbside ? "curbside" : "counter", "p_vehicle": vehicle, "p_items": itemPayload])
            guard let orderID = response["order_id"] as? String, UUID(uuidString: orderID) != nil else { throw CenaBackendError.invalidResponse }
            let checkoutURL = response["checkout_url"] as? String
            pendingCheckoutID = orderID; pendingCheckoutURL = checkoutURL; paymentStatus = "pending"
            pendingCheckoutOwnerID = profileUserID
            UserDefaults.standard.set(orderID, forKey: "cena.checkout.pendingOrderID")
            UserDefaults.standard.set(profileUserID, forKey: "cena.checkout.pendingOwnerID")
            if let profileUserID {
                UserDefaults.standard.set(orderID, forKey: pendingIDKey(profileUserID))
                if let checkoutURL { UserDefaults.standard.set(checkoutURL, forKey: pendingURLKey(profileUserID)) }
            }
            UserDefaults.standard.removeObject(forKey: "cena.checkout.pendingURL")
            tab = 2
            if response["status"] as? String == "paid" { await refreshPendingCheckout() }
            else { paymentMessage = "Opening secure Stripe Checkout…"; await openPendingCheckout() }
        } catch let CenaBackendError.conflict(detail) {
            clearPendingCheckout(resetIdempotency: true)
            message = "This saved checkout is no longer pending. \(detail) Your bag is saved; start a new payment attempt."
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
    @ViewBuilder private func priceComparison(_ item: [String: Any]) -> some View {
        let kitPrice = int(item["price_cents"])
        let preparedPrice: Int? = {
            guard let value = item["prepared_meal_total_cents"], !(value is NSNull) else { return nil }
            return int(value)
        }()
        HStack(spacing: 7) {
            Text("$\(money(kitPrice))").font(.subheadline.weight(.semibold)).foregroundStyle(CenaStyle.maroon)
            if let preparedPrice, preparedPrice > kitPrice {
                Text("$\(money(preparedPrice))").font(.caption).strikethrough(true, color: .secondary).foregroundStyle(.secondary)
                    .accessibilityLabel("Prepared meal including tax, $\(money(preparedPrice))")
            }
        }
        if let preparedPrice, preparedPrice > kitPrice {
            Text("Prepared meal including tax").font(.caption2).foregroundStyle(.secondary)
        }
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
