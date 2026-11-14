import SwiftUI
import UIKit

@main struct CenaRestaurantApp: App {
    var body: some Scene { WindowGroup { RestaurantHome().tint(CenaStyle.maroon) } }
}

struct RestaurantHome: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var api = CenaBackend.shared
    @State private var email = "", password = ""
    @State private var restaurants: [[String: Any]] = []
    @State private var selectedRestaurant: [String: Any]?
    @State private var orders: [[String: Any]] = []
    @State private var catalog: [[String: Any]] = []
    @State private var selectedTab = "Orders"
    @State private var busy = false
    @State private var notice: String?
    @State private var paymentStatus = "not_connected"
    @State private var applicationFeeCents = 0
    @State private var onboardingBusy = false
    @State private var refundOrderID: String?
    @State private var refundBusy = false
    private var restaurantID: String { selectedRestaurant?["id"] as? String ?? "" }
    private var activeOrders: [[String: Any]] { orders.filter { !["completed", "cancelled"].contains(($0["status"] as? String ?? "").lowercased()) } }

    var body: some View {
        NavigationStack {
            Group {
                if !api.signedIn { signIn }
                else if restaurants.isEmpty { noRestaurant }
                else if let r = selectedRestaurant { workspace(r) }
                else { restaurantPicker }
            }
            .frame(maxWidth: horizontalSizeClass == .regular ? 760 : .infinity)
            .frame(maxWidth: .infinity, alignment: .top)
            .navigationTitle(selectedRestaurant?["name"] as? String ?? "Cena for Restaurants")
            .toolbar {
                if api.signedIn {
                    ToolbarItem(placement: .topBarTrailing) { Button("Sign out") { api.signOut(); restaurants = []; selectedRestaurant = nil } }
                }
            }
            .background(CenaStyle.cream)
            .overlay(alignment: .top) { if let notice { CenaNotice(message: notice) { self.notice = nil }.padding(.horizontal, 14).padding(.top, 8).transition(.move(edge: .top).combined(with: .opacity)) } }
            .animation(.easeInOut(duration: 0.2), value: notice)
            .task { if api.signedIn { await loadRestaurants() } }
            .onChange(of: scenePhase) { _, phase in if phase == .active, !restaurantID.isEmpty { Task { await loadPaymentStatus() } } }
        }
    }

    private var signIn: some View {
        Form {
            Section {
                Text("Your kitchen,\nready for tonight.").font(.system(size: 32, weight: .bold, design: .serif)).foregroundStyle(CenaStyle.maroon)
                Text("Restaurant team access uses your Cena account.").foregroundStyle(.secondary)
                if !api.configured { Label("Supabase backend is not configured", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            }
            Section("Team sign in") {
                TextField("Email", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress).textContentType(.emailAddress)
                SecureField("Password", text: $password).textContentType(.password)
                Button(busy ? "Signing in…" : "Sign in") { Task { await signIn() } }.disabled(busy || email.isEmpty || password.isEmpty || !api.configured)
            }
        }.scrollContentBackground(.hidden)
    }
    private var noRestaurant: some View { VStack(spacing: 12) { Image(systemName: "storefront").font(.largeTitle).foregroundStyle(CenaStyle.maroon); Text("No restaurant access").font(.title2.bold()); Text("This account is not assigned to a restaurant. Ask an owner to add your membership.").multilineTextAlignment(.center).foregroundStyle(.secondary); Button("Try again") { Task { await loadRestaurants() } }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon) }.padding(28) }
    private var restaurantPicker: some View {
        List { Section("Your locations") { ForEach(Array(restaurants.enumerated()), id: \.offset) { _, r in Button { selectedRestaurant = r; Task { await loadWorkspace() } } label: { VStack(alignment: .leading) { Text(r["name"] as? String ?? "Restaurant").font(.headline).foregroundStyle(.primary); Text(r["address"] as? String ?? "").font(.subheadline).foregroundStyle(.secondary) }.padding(.vertical, 6) } } } }.scrollContentBackground(.hidden)
    }
    private func workspace(_ restaurant: [String: Any]) -> some View {
        VStack(spacing: 0) {
            if selectedTab == "Orders" { ordersView }
            else if selectedTab == "Menu" { menuView }
            else { manageView(restaurant) }
            HStack { tab("Orders", icon: "tray.full"); tab("Menu", icon: "menucard"); tab("Manage", icon: "slider.horizontal.3") }.padding(.vertical, 10).background(.white)
        }.task { await loadWorkspace() }.refreshable { await loadWorkspace() }
    }
    private var ordersView: some View {
        List {
            Section {
                HStack { Label("\(activeOrders.count) active", systemImage: "clock"); Spacer(); Text("Refresh for latest").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Today's orders") {
                if orders.isEmpty { Text("No orders for this location today.").foregroundStyle(.secondary) }
                ForEach(Array(orders.enumerated()), id: \.offset) { _, order in orderCard(order) }
            }
        }.scrollContentBackground(.hidden)
            .confirmationDialog("Refund this customer’s full payment?", isPresented: Binding(get: { refundOrderID != nil }, set: { if !$0 { refundOrderID = nil } }), titleVisibility: .visible) {
                Button(refundBusy ? "Processing…" : "Refund full payment", role: .destructive) { Task { await refundPaidOrder() } }.disabled(refundBusy)
                Button("Keep order", role: .cancel) { refundOrderID = nil }
            } message: {
                Text("Cena will request a full refund through Stripe. The order is cancelled only after Stripe confirms the refund. This cannot be undone.")
            }
    }
    private func orderCard(_ order: [String: Any]) -> some View {
        let status = order["status"] as? String ?? "placed"
        let items = order["items"] as? [[String: Any]] ?? []
        return VStack(alignment: .leading, spacing: 8) {
            HStack { Text("#\((order["id"] as? String ?? "").prefix(8).uppercased())").font(.headline); Spacer(); Text(status.capitalized).font(.caption.weight(.bold)).padding(.horizontal, 9).padding(.vertical, 5).background(CenaStyle.cream).clipShape(Capsule()) }
            Text(items.map { "\($0["quantity"] as? Int ?? 1) × \($0["name_snapshot"] as? String ?? "Item")" }.joined(separator: " · ")).font(.subheadline)
            HStack { Text((order["pickup_mode"] as? String ?? "counter").capitalized + " pickup"); Spacer(); Text("$\(money(order["subtotal_cents"] as? Int ?? 0))") }.font(.subheadline).foregroundStyle(.secondary)
            if let starts = order["pickup_starts_at"] as? String { Text(starts).font(.caption).foregroundStyle(.secondary) }
            HStack {
                if status == "placed" { action("Accept", id: order["id"] as? String, next: "accepted") }
                else if status == "accepted" { action("Start preparing", id: order["id"] as? String, next: "preparing") }
                else if status == "preparing" { action("Mark ready", id: order["id"] as? String, next: "ready") }
                else if status == "ready" { action("Complete pickup", id: order["id"] as? String, next: "completed") }
                if status == "placed", order["payment_method"] as? String != "stripe_checkout" {
                    action("Cancel", id: order["id"] as? String, next: "cancelled", outline: true)
                } else if order["payment_method"] as? String == "stripe_checkout", order["payment_status"] as? String == "paid", !["completed", "cancelled"].contains(status) {
                    Button("Refund payment") { refundOrderID = order["id"] as? String }.buttonStyle(.bordered).tint(.red).disabled(refundBusy)
                } else if order["payment_method"] as? String == "stripe_checkout", order["payment_status"] as? String == "refunded" {
                    Label("Payment refunded", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.secondary)
                } else if status == "placed", order["payment_method"] as? String == "stripe_checkout" {
                    Text("This online payment cannot be cancelled until its payment status is confirmed.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.padding(14).cenaCardBackground(.white).padding(.vertical, 5)
    }
    @ViewBuilder private func action(_ title: String, id: String?, next: String, outline: Bool = false) -> some View {
        if outline {
            Button(title) { guard let id else { return }; Task { await update(id, next) } }.buttonStyle(.bordered).tint(.gray)
        } else {
            Button(title) { guard let id else { return }; Task { await update(id, next) } }.buttonStyle(.borderedProminent).tint(CenaStyle.maroon)
        }
    }
    private var menuView: some View {
        List {
            Section("Published and draft items") {
                if catalog.isEmpty { Text("No menu items found for this restaurant.").foregroundStyle(.secondary) }
                ForEach(Array(catalog.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(item["name"] as? String ?? "Menu item").font(.headline); Spacer(); Text(item["active"] as? Bool == true ? "Active" : "Paused").font(.caption.weight(.semibold)).foregroundStyle(item["active"] as? Bool == true ? .green : .secondary) }
                        Text("$\(money(item["price_cents"] as? Int ?? 0)) · \(item["category"] as? String ?? "Menu")").font(.subheadline).foregroundStyle(.secondary)
                        Text(item["published_at"] == nil || item["published_at"] is NSNull ? "Draft · not visible to customers" : "Published").font(.caption).foregroundStyle(CenaStyle.maroon)
                        if let description = item["description"] as? String, !description.isEmpty { Text(description).font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 5)
                }
            }
            Section { Text("Menu editing and chef-step publishing are managed in the web/Expo restaurant console in this build.").font(.caption).foregroundStyle(.secondary) }
        }.scrollContentBackground(.hidden)
    }
    private func manageView(_ r: [String: Any]) -> some View {
        Form {
            Section("Location") { Text(r["name"] as? String ?? ""); Text(r["address"] as? String ?? "").foregroundStyle(.secondary) }
            Section("Pickup") {
                Toggle("Allow curbside pickup", isOn: Binding(get: { r["curbside_enabled"] as? Bool ?? false }, set: { value in Task { await setCurbside(value) } }))
                Text("Customers pay securely in Cena. Use the order’s Refund payment action for online orders; Stripe confirmation is required before cancellation. Order status changes are recorded on the shared backend.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Payments in Cena") {
                if paymentStatus == "ready" {
                    Label("Stripe is connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Text(paymentStatus == "pending" ? "Stripe setup is not complete." : "Connect Stripe to accept secure in-Cena payments.").font(.subheadline).foregroundStyle(.secondary)
                    Button(onboardingBusy ? "Opening Stripe…" : (paymentStatus == "pending" ? "Continue Stripe setup" : "Connect with Stripe")) { Task { await startStripeOnboarding() } }
                        .disabled(onboardingBusy || !api.paymentGatewayConfigured)
                    if !api.paymentGatewayConfigured { Text("Cena’s payment API is not configured.").font(.caption).foregroundStyle(.orange) }
                }
                if applicationFeeCents > 0 { Text("Application fee: $\(money(applicationFeeCents)) per order").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Location selection") { Button("Switch location") { selectedRestaurant = nil } }
        }.scrollContentBackground(.hidden)
    }
    private func tab(_ title: String, icon: String) -> some View { Button { selectedTab = title } label: { Label(title, systemImage: icon).frame(maxWidth: .infinity).foregroundStyle(selectedTab == title ? CenaStyle.maroon : .secondary) } }
    private func signIn() async {
        busy = true; defer { busy = false }
        do { try await api.signIn(email: email, password: password); await loadRestaurants() } catch { notice = error.localizedDescription }
    }
    private func loadRestaurants() async {
        guard api.configured, api.signedIn else { return }
        do {
            let rows = try await api.rows("merchant_memberships", query: "select=restaurant:restaurants(id,name,address,curbside_enabled)&order=created_at.asc", authenticated: true)
            restaurants = rows.compactMap { $0["restaurant"] as? [String: Any] }
            if selectedRestaurant == nil { selectedRestaurant = restaurants.first }
            if selectedRestaurant != nil { await loadWorkspace() }
        } catch { notice = error.localizedDescription }
    }
    private func loadWorkspace() async {
        guard !restaurantID.isEmpty else { return }
        do {
            async let o = api.rows("orders", query: "select=id,status,payment_method,payment_status,pickup_mode,subtotal_cents,created_at,pickup_starts_at,pickup_ends_at,restaurant_timezone,vehicle,items:order_items(name_snapshot,quantity)&restaurant_id=eq.\(restaurantID)&created_at=gte.\(today)&order=created_at.desc", authenticated: true)
            async let c = api.rows("catalog_items", query: "select=id,name,description,price_cents,category,active,published_at&restaurant_id=eq.\(restaurantID)&order=category.asc,name.asc", authenticated: true)
            orders = try await o; catalog = try await c
            if let selectedRestaurant, let ix = restaurants.firstIndex(where: { ($0["id"] as? String) == (selectedRestaurant["id"] as? String) }) { restaurants[ix] = selectedRestaurant }
            await loadPaymentStatus()
        } catch { notice = error.localizedDescription }
    }
    private func update(_ id: String, _ status: String) async {
        do { try await api.updateOrder(id, status: status); await loadWorkspace() } catch { notice = error.localizedDescription }
    }
    private func refundPaidOrder() async {
        guard let id = refundOrderID,
              let order = orders.first(where: { ($0["id"] as? String) == id }),
              order["payment_method"] as? String == "stripe_checkout",
              order["payment_status"] as? String == "paid",
              !["completed", "cancelled"].contains((order["status"] as? String ?? "").lowercased()) else {
            notice = "This order is not eligible for a refund. Refresh Orders and try again."
            refundOrderID = nil
            return
        }
        refundBusy = true; defer { refundBusy = false; refundOrderID = nil }
        do {
            let response = try await api.apiRequest("/v1/orders/\(id)/refund", method: "POST", body: [:], authenticated: true)
            guard let status = (response as? [String: Any])?["status"] as? String else { throw CenaBackendError.invalidResponse }
            switch status.lowercased() {
            case "refunded": notice = "Stripe confirmed the refund. The order is cancelled."; await loadWorkspace()
            case "pending": notice = "Stripe is processing the refund. The order remains active until confirmation. Refresh Orders to check again."; await loadWorkspace()
            case "failed": notice = "Stripe did not complete the refund. The order remains active; retry here or use your Stripe dashboard."; await loadWorkspace()
            default: notice = "The refund status is unclear. Refresh Orders before taking further action."; await loadWorkspace()
            }
        } catch { notice = "Couldn’t confirm the refund: \(error.localizedDescription). The order remains active unless Stripe confirms it." }
    }
    private func setCurbside(_ value: Bool) async {
        guard let r = selectedRestaurant, let id = r["id"] as? String else { return }
        do {
            _ = try await api.patch("restaurants", query: "id=eq.\(id)", body: ["curbside_enabled": value], authenticated: true)
            var changed = r; changed["curbside_enabled"] = value; selectedRestaurant = changed
        } catch { notice = error.localizedDescription }
    }
    private func loadPaymentStatus() async {
        guard api.paymentGatewayConfigured, api.signedIn, !restaurantID.isEmpty else { return }
        do {
            let response = try await api.apiRequest("/v1/restaurants/\(restaurantID)/payments", authenticated: true)
            guard let body = response as? [String: Any], let status = body["status"] as? String else { throw CenaBackendError.invalidResponse }
            paymentStatus = status; applicationFeeCents = body["application_fee_cents"] as? Int ?? 0
        } catch { notice = "Couldn’t load Stripe status: \(error.localizedDescription)" }
    }
    private func startStripeOnboarding() async {
        guard api.paymentGatewayConfigured, !restaurantID.isEmpty else { notice = "Cena’s payment API is not configured."; return }
        onboardingBusy = true; defer { onboardingBusy = false }
        do {
            let response = try await api.apiRequest("/v1/restaurants/\(restaurantID)/stripe-onboarding", method: "POST", body: [:], authenticated: true)
            guard let body = response as? [String: Any], let rawURL = body["url"] as? String,
                  let url = URL(string: rawURL), url.scheme?.lowercased() == "https", url.host?.lowercased() == "connect.stripe.com" else {
                throw CenaBackendError.server("Stripe returned an invalid onboarding URL.")
            }
            let opened = await UIApplication.shared.open(url)
            if !opened { notice = "Couldn’t open Stripe onboarding. Try again." }
        } catch { notice = error.localizedDescription }
    }
    private var today: String { let f = ISO8601DateFormatter(); return f.string(from: Calendar.current.startOfDay(for: Date())) }
}

private func money(_ cents: Int) -> String { String(format: "%.2f", Double(cents) / 100) }
