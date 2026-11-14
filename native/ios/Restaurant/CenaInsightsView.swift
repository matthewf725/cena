import SwiftUI

private enum InsightsPeriod: String, CaseIterable, Identifiable {
    case thirtyDays = "30 days"
    case ninetyDays = "90 days"

    var id: String { rawValue }
    var days: Int { self == .thirtyDays ? 30 : 90 }
}

private struct MerchantInsights {
    let orderCount: Int
    let completedCount: Int
    let completedKits: Int
    let stripeGrossCents: Int
    let refundedStripeCents: Int
    let completedPickupOrders: Int

    init(orders: [[String: Any]]) {
        var completedCount = 0
        var completedKits = 0
        var stripeGross = 0
        var refunded = 0
        var completedPickupOrders = 0

        for order in orders {
            let status = (order["status"] as? String ?? "").lowercased()
            let paymentStatus = (order["payment_status"] as? String ?? "").lowercased()
            let paymentMethod = (order["payment_method"] as? String ?? "").lowercased()
            let amount = (order["total_cents"] as? Int) ?? (order["subtotal_cents"] as? Int) ?? 0

            if status == "completed" {
                completedCount += 1
                if paymentMethod == "pay_at_pickup" { completedPickupOrders += 1 }
                let items = order["items"] as? [[String: Any]] ?? []
                completedKits += items.reduce(0) { $0 + merchantInsightInt($1["quantity"]) }
            }

            guard paymentMethod == "stripe_checkout" else { continue }
            if paymentStatus == "paid" || paymentStatus == "refunded" { stripeGross += amount }
            if paymentStatus == "refunded" { refunded += amount }
        }

        orderCount = orders.filter(insightOrderIsConfirmed).count
        self.completedCount = completedCount
        self.completedKits = completedKits
        stripeGrossCents = stripeGross
        refundedStripeCents = refunded
        self.completedPickupOrders = completedPickupOrders
    }

    var netStripeCents: Int { stripeGrossCents - refundedStripeCents }
}

struct CenaInsightsView: View {
    let restaurantID: String

    @State private var period: InsightsPeriod = .thirtyDays
    @State private var insights: MerchantInsights?
    @State private var loading = false
    @State private var errorMessage: String?
    @State private var loadedAt: Date?
    @State private var resultsTruncated = false
    @State private var currentRequestID = UUID()
    @State private var loadedSelectionKey: String?
    @State private var errorSelectionKey: String?

    private var selectionKey: String { "\(restaurantID)|\(period.rawValue)" }
    private var currentInsights: MerchantInsights? { loadedSelectionKey == selectionKey ? insights : nil }
    private var currentErrorMessage: String? { errorSelectionKey == selectionKey ? errorMessage : nil }

    var body: some View {
        List {
            Section {
                Picker("Reporting period", selection: $period) {
                    ForEach(InsightsPeriod.allCases) { option in
                        Text("Past \(option.rawValue)").tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Insights reporting period")
            }

            if loading && currentInsights == nil {
                Section { ProgressView("Loading order insights…") }
            } else if let insights = currentInsights, hasAnyOrdersOrPayments(insights) {
                Section("Order activity · past \(period.rawValue)") {
                    Text("Orders are grouped by creation date. Stripe payments and refunds shown here are not a payout or settlement report.")
                        .font(.caption).foregroundStyle(CenaStyle.clay)
                    if let currentErrorMessage {
                        Label("Refresh failed: \(currentErrorMessage)", systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(CenaStyle.coral)
                    }
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                        metric("Orders placed", value: "\(insights.orderCount)", detail: "Confirmed orders")
                        metric("Completed pickups", value: "\(insights.completedCount)", detail: "Marked completed")
                        metric("Kits in completed orders", value: "\(insights.completedKits)", detail: "Quantity from order items")
                        metric("Stripe payments · gross", value: currency(insights.stripeGrossCents), detail: "Paid or later refunded")
                        metric("Stripe refunded", value: currency(insights.refundedStripeCents), detail: "Full refunds confirmed")
                        metric("Net Stripe payments", value: currency(insights.netStripeCents), detail: "Confirmed minus refunds")
                    }
                    .padding(.vertical, 4)
                    if insights.completedPickupOrders > 0 {
                        Text("\(insights.completedPickupOrders) completed pay-at-pickup orders are not included in Stripe totals; Cena does not record whether those payments were collected.")
                            .font(.caption).foregroundStyle(CenaStyle.clay)
                    }
                    if resultsTruncated {
                        Text("This report reached its 10,000 order limit. Earlier records in the selected period may be omitted.")
                            .font(.caption).foregroundStyle(CenaStyle.coral)
                    }
                    if let loadedAt {
                        Text("Updated \(loadedAt.formatted(date: .omitted, time: .shortened))")
                            .font(.caption).foregroundStyle(CenaStyle.clay)
                    }
                }
            } else if let currentErrorMessage {
                Section {
                    ContentUnavailableView {
                        Label("Insights unavailable", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text(currentErrorMessage)
                    } actions: {
                        Button("Retry") { Task { await load() } }.buttonStyle(.borderedProminent)
                    }
                }
            } else if let insights = currentInsights {
                Section {
                    ContentUnavailableView("No orders in this period", systemImage: "chart.bar.xaxis", description: Text("Completed pickups and confirmed Stripe payments will appear here when this location has order history."))
                    if let currentErrorMessage { Text(currentErrorMessage).font(.caption).foregroundStyle(CenaStyle.coral) }
                    if insights.refundedStripeCents > 0 {
                        Text("Refunds recorded: \(currency(insights.refundedStripeCents))").foregroundStyle(CenaStyle.clay)
                    }
                }
            } else {
                Section {
                    ContentUnavailableView("No orders in this period", systemImage: "chart.bar.xaxis", description: Text("Completed pickups and payment totals will appear here when this location has order history."))
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(CenaStyle.cream)
        .tint(CenaStyle.maroon)
        .navigationTitle("Insights")
        .task(id: "\(restaurantID)-\(period.id)") { await load() }
        .refreshable { await load() }
        .overlay(alignment: .top) {
            if loading && currentInsights != nil {
                ProgressView().padding(10).background(CenaStyle.paper, in: Capsule()).padding(.top, 8)
            }
        }
    }

    private func metric(_ title: String, value: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(CenaStyle.clay)
            Text(value).font(.system(.title2, design: .rounded).weight(.bold)).foregroundStyle(CenaStyle.ink).minimumScaleFactor(0.75).lineLimit(1)
            Text(detail).font(.caption2).foregroundStyle(CenaStyle.clay).lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .padding(12)
        .cenaCardBackground(CenaStyle.paper, outline: CenaStyle.rose)
        .accessibilityElement(children: .combine)
    }

    @MainActor private func load() async {
        guard !restaurantID.isEmpty else { return }
        let requestedSelectionKey = selectionKey
        let requestID = UUID()
        currentRequestID = requestID
        if loadedSelectionKey != requestedSelectionKey {
            loadedAt = nil
            resultsTruncated = false
            errorMessage = nil
            errorSelectionKey = nil
        }
        loading = true
        defer { if currentRequestID == requestID { loading = false } }

        let start = Calendar(identifier: .gregorian).date(byAdding: .day, value: -period.days, to: Date()) ?? Date().addingTimeInterval(-Double(period.days) * 86_400)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let createdAfter = formatter.string(from: start)
        let queryBase = "select=id,status,payment_method,payment_status,total_cents,subtotal_cents,created_at,items:order_items(quantity)&restaurant_id=eq.\(restaurantID)&created_at=gte.\(createdAfter)&order=created_at.desc,id.desc&limit=500"

        do {
            var orders: [[String: Any]] = []
            var offset = 0
            let pageSize = 500
            resultsTruncated = false
            while offset < 10_000 {
                try Task.checkCancellation()
                let pageQuery = queryBase.replacingOccurrences(of: "&limit=500", with: "&limit=\(pageSize)&offset=\(offset)")
                let page = try await CenaBackend.shared.rows("orders", query: pageQuery, authenticated: true)
                orders.append(contentsOf: page)
                if page.count < pageSize { break }
                offset += pageSize
            }
            guard currentRequestID == requestID, selectionKey == requestedSelectionKey else { return }
            resultsTruncated = offset >= 10_000
            insights = MerchantInsights(orders: orders)
            loadedSelectionKey = requestedSelectionKey
            loadedAt = Date()
            errorMessage = nil
            errorSelectionKey = nil
        } catch is CancellationError {
            return
        } catch {
            guard currentRequestID == requestID else { return }
            errorMessage = error.localizedDescription
            errorSelectionKey = requestedSelectionKey
        }
    }

    private func currency(_ cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: Double(cents) / 100)) ?? "$0.00"
    }

    private func hasAnyOrdersOrPayments(_ value: MerchantInsights) -> Bool {
            value.orderCount > 0 || value.stripeGrossCents > 0 || value.refundedStripeCents > 0
    }
}

private func insightOrderIsConfirmed(_ order: [String: Any]) -> Bool {
    let status = (order["status"] as? String ?? "").lowercased()
    let paymentStatus = (order["payment_status"] as? String ?? "").lowercased()
    return status != "pending_payment" && status != "cancelled" && !["pending", "expired", "failed", "cancelled"].contains(paymentStatus)
}

private func merchantInsightInt(_ value: Any?) -> Int {
    (value as? Int) ?? ((value as? NSNumber)?.intValue ?? 0)
}
