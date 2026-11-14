import SwiftUI

private struct RestaurantPromotion: Identifiable {
    let id: String
    let code: String
    let percent: Int
    let startsAt: Date
    let endsAt: Date?
    let limit: Int?
    let used: Int
    let held: Int
    let active: Bool

    init?(row: [String: Any]) {
        guard let id = row["id"] as? String, let code = row["code"] as? String,
              let percent = row["discount_percent"] as? Int,
              let start = row["starts_at"] as? String, let startsAt = Self.date(start) else { return nil }
        self.id = id
        self.code = code
        self.percent = percent
        self.startsAt = startsAt
        endsAt = (row["ends_at"] as? String).flatMap(Self.date)
        limit = row["max_redemptions"] as? Int
        used = row["redeemed_count"] as? Int ?? 0
        held = row["reserved_redemptions"] as? Int ?? 0
        active = row["active"] as? Bool ?? false
    }

    var availability: String {
        if !active { return "Paused" }
        if let endsAt, endsAt <= .now { return "Ended" }
        if let limit, used + held >= limit { return "Limit reached" }
        return startsAt > .now ? "Scheduled" : "Live"
    }

    private static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

struct CenaPromotionsView: View {
    let restaurantID: String
    @State private var promotions: [RestaurantPromotion] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var editor: PromotionDraft?

    var body: some View {
        List {
            if let loadError {
                Section {
                    Text(loadError).foregroundStyle(.secondary)
                    Button("Retry") { Task { await load() } }
                }
            } else if loading {
                ProgressView("Loading promo codes")
            } else {
                Section {
                    Button("New promo code", systemImage: "plus") { editor = PromotionDraft() }
                }
                Section("Codes for this location") {
                    if promotions.isEmpty { Text("No promo codes yet.").foregroundStyle(.secondary) }
                    ForEach(promotions) { promotion in
                        Button { editor = PromotionDraft(promotion) } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(promotion.code).font(.headline).foregroundStyle(.primary)
                                Text("\(promotion.percent)% off · \(promotion.availability)")
                                    .font(.subheadline).foregroundStyle(.secondary)
                                if let limit = promotion.limit {
                                    Text("\(promotion.used) of \(limit) used · \(promotion.held) reserved")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Promo codes")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editor) { draft in
            PromotionEditor(restaurantID: restaurantID, draft: draft, existingCodes: Set(promotions.map(\.code))) {
                editor = nil
                await load()
            }
        }
    }

    @MainActor private func load() async {
        defer { loading = false }
        do {
            let response = try await CenaBackend.shared.rpc("list_restaurant_promotions", body: ["p_restaurant_id": restaurantID])
            guard let rows = response as? [[String: Any]] else { throw CenaBackendError.invalidResponse }
            promotions = rows.compactMap(RestaurantPromotion.init(row:))
            guard promotions.count == rows.count else { throw CenaBackendError.invalidResponse }
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }
}

private struct PromotionDraft: Identifiable {
    let id = UUID()
    let isEditing: Bool
    var code: String
    var percent: String
    var startsAt: Date
    var endsAt: Date
    var hasEnd: Bool
    var limit: String
    var active: Bool

    init(_ promotion: RestaurantPromotion? = nil) {
        isEditing = promotion != nil
        code = promotion?.code ?? ""
        percent = promotion.map { String($0.percent) } ?? "10"
        startsAt = promotion?.startsAt ?? .now
        endsAt = promotion?.endsAt ?? startsAt.addingTimeInterval(86_400)
        hasEnd = promotion?.endsAt != nil
        limit = promotion?.limit.map { String($0) } ?? ""
        active = promotion?.active ?? false
    }
}

private struct PromotionEditor: View {
    @Environment(\.dismiss) private var dismiss
    let restaurantID: String
    @State var draft: PromotionDraft
    let existingCodes: Set<String>
    let onSaved: @MainActor () async -> Void
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Code") {
                    if draft.isEditing {
                        LabeledContent("Promo code", value: draft.code)
                    } else {
                        TextField("Promo code", text: $draft.code)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.characters)
                    }
                    TextField("Percent off", text: $draft.percent).keyboardType(.numberPad)
                    TextField("Redemption limit (optional)", text: $draft.limit).keyboardType(.numberPad)
                }
                Section("Availability") {
                    DatePicker("Starts", selection: $draft.startsAt)
                    Toggle("Set an end date", isOn: $draft.hasEnd)
                    if draft.hasEnd { DatePicker("Ends", selection: $draft.endsAt) }
                    Toggle("Accept this code", isOn: $draft.active)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
                }
            }
            .disabled(saving)
            .navigationTitle(draft.isEditing ? "Edit promo code" : "New promo code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }.disabled(saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    @MainActor private func save() async {
        guard !saving else { return }
        let code = draft.code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard code.range(of: #"^[A-Z0-9][A-Z0-9_-]{2,31}$"#, options: .regularExpression) != nil else {
            errorMessage = "Use 3–32 letters, numbers, hyphens, or underscores. Start with a letter or number."
            return
        }
        guard draft.isEditing || !existingCodes.contains(code) else {
            errorMessage = "This location already has that code. Open it to make changes."
            return
        }
        guard let percent = Int(draft.percent), (1...90).contains(percent) else {
            errorMessage = "Enter a whole discount percentage from 1 to 90."
            return
        }
        let limitText = draft.limit.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = Int32(limitText)
        guard limitText.isEmpty || (limit ?? 0) > 0 else {
            errorMessage = "Enter a positive whole number for the redemption limit."
            return
        }
        guard !draft.hasEnd || draft.endsAt > draft.startsAt else {
            errorMessage = "Choose an end time after the start time."
            return
        }

        saving = true
        errorMessage = nil
        defer { saving = false }
        let formatter = ISO8601DateFormatter()
        let body: [String: Any] = [
            "p_restaurant_id": restaurantID,
            "p_code": code,
            "p_discount_percent": percent,
            "p_starts_at": formatter.string(from: draft.startsAt),
            "p_ends_at": draft.hasEnd ? formatter.string(from: draft.endsAt) as Any : NSNull(),
            "p_max_redemptions": limit.map { $0 as Any } ?? NSNull(),
            "p_active": draft.active,
        ]
        do {
            _ = try await CenaBackend.shared.rpc("save_restaurant_promotion", body: body)
            await onSaved()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
