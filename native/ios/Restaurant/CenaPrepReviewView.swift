import SwiftUI

struct CenaPrepReviewView: View {
    let restaurantID: String
    let item: [String: Any]
    let onPublished: @MainActor () async -> Void

    @State private var draftID: String?
    @State private var updatedAt: String?
    @State private var steps: [String] = []
    @State private var publishedSteps: [String] = []
    @State private var manualSourceConfirmed = false
    @State private var loading = true
    @State private var saving = false
    @State private var generating = false
    @State private var publishing = false
    @State private var reviewConfirmed = false
    @State private var notice: String?
    @State private var draftLoadID = UUID()

    private var itemID: String { prepString(item["id"]) }
    @MainActor private var currentUserID: String? {
        guard let token = CenaBackend.shared.accessToken else { return nil }
        let segments = token.split(separator: ".")
        guard segments.count > 1 else { return nil }
        var payload = String(segments[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return claims["sub"] as? String
    }
    private var validSteps: Bool {
        !steps.isEmpty && steps.count <= 80 && steps.reduce(0, { $0 + $1.count }) <= 12_000 && steps.allSatisfy {
            let trimmed = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && trimmed.count <= 2_000
        }
    }

    var body: some View {
        Form {
            Section("Menu item") {
                Text(prepString(item["name"]))
                    .font(.headline).foregroundStyle(CenaStyle.ink)
                Text("$\(money(prepInt(item["price_cents"]))) · \(prepString(item["category"]))")
                    .font(.subheadline).foregroundStyle(CenaStyle.clay)
                if let description = item["description"] as? String, !description.isEmpty {
                    Text(description).font(.caption).foregroundStyle(CenaStyle.clay)
                }
            }

            Section("Chef steps · private until published") {
                if loading {
                    ProgressView("Loading saved chef steps…")
                } else if steps.isEmpty {
                    Text("No saved or generated steps yet. Add a first step below, then confirm it as the private source before generating.")
                        .font(.subheadline).foregroundStyle(CenaStyle.clay)
                } else {
                    ForEach(Array(steps.enumerated()), id: \.offset) { index, _ in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(index + 1)").font(.caption.weight(.semibold)).foregroundStyle(CenaStyle.clay).frame(width: 22, alignment: .leading).padding(.top, 9)
                            TextField("Prep step", text: stepBinding(at: index), axis: .vertical)
                                .lineLimit(2...5)
                                .accessibilityLabel("Preparation step \(index + 1)")
                            Button(role: .destructive) {
                                steps.remove(at: index)
                                reviewConfirmed = false
                            } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(CenaStyle.coral)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove step \(index + 1)")
                        }
                    }
                }

                Button("Add preparation step", systemImage: "plus") {
                    steps.append("")
                    reviewConfirmed = false
                }
                .disabled(loading || steps.count >= 80)

                if !steps.isEmpty && !validSteps {
                    Text("Add 1–80 non-empty steps, each 2,000 characters or fewer and 12,000 characters total.")
                        .font(.caption).foregroundStyle(CenaStyle.coral)
                }
            }

            Section("AI preparation draft") {
                Text("Generation sends only this menu item’s ID. Cena uses the saved private chef source to create an editable draft; it never publishes automatically.")
                    .font(.caption).foregroundStyle(CenaStyle.clay)
                if draftID == nil {
                    Button(generating ? "Saving source and generating…" : "Save source and generate private draft") {
                        Task { await generatePrivateDraft() }
                    }
                    .disabled(loading || saving || generating || publishing || !validSteps || !manualSourceConfirmed)
                } else {
                    Button(generating ? "Generating private draft…" : "Generate private AI draft") {
                        Task { await generatePrivateDraft() }
                    }
                    .disabled(loading || saving || generating || publishing || !validSteps)
                    Text("Generation uses the saved chef source and replaces generated draft text. Unsaved edits in this review field are not used as its source.")
                        .font(.caption).foregroundStyle(CenaStyle.clay)
                }
            }

            if !publishedSteps.isEmpty {
                Section("Currently published steps") {
                    ForEach(Array(publishedSteps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)").font(.subheadline).foregroundStyle(CenaStyle.clay)
                    }
                }
            }

            if !loading && draftID == nil {
                Section("First private chef source") {
                    Toggle("Use these as the first private source", isOn: $manualSourceConfirmed)
                    Text("No private chef source exists yet. Confirm before these steps are copied into the private source draft; they remain hidden until you publish.")
                        .font(.caption).foregroundStyle(CenaStyle.clay)
                }
            }

            if !loading && !steps.isEmpty {
                Section("Review") {
                    Toggle("I reviewed every preparation step", isOn: $reviewConfirmed)
                        .tint(CenaStyle.maroon)
                    Text("Only reviewed steps are published to the customer menu. Saving keeps them private.")
                        .font(.caption).foregroundStyle(CenaStyle.clay)
                }
            }

            Section {
                if draftID == nil {
                    Button(saving ? "Saving source…" : "Save private source draft") { Task { await saveManualSource() } }
                        .disabled(loading || saving || publishing || !validSteps || !manualSourceConfirmed)
                }
                Button(publishing ? "Publishing…" : "Publish reviewed steps") { Task { await publishReviewedSteps() } }
                    .buttonStyle(.borderedProminent)
                    .tint(CenaStyle.maroon)
                    .disabled(loading || saving || publishing || !validSteps || !reviewConfirmed)
            } footer: {
                Text("Publishing requires owner or manager access. Existing private source steps are preserved; edits here are sent only when you publish.")
            }

            if let notice {
                Section { Text(notice).font(.subheadline).foregroundStyle(notice.hasPrefix("Couldn’t") ? CenaStyle.maroon : CenaStyle.clay) }
            }
        }
        .disabled(loading || saving || generating || publishing)
        .scrollContentBackground(.hidden)
        .scrollIndicators(.hidden)
        .background(CenaStyle.cream)
        .tint(CenaStyle.maroon)
        .navigationTitle("Chef step review")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(restaurantID):\(itemID)") { await loadDraft() }
        .refreshable { if !saving && !generating && !publishing { await loadDraft() } }
        .overlay(alignment: .top) {
            if let notice, notice.hasPrefix("Couldn’t") {
                CenaNotice(message: notice) { self.notice = nil }.padding(.horizontal, 14).padding(.top, 8)
            }
        }
    }

    private func stepBinding(at index: Int) -> Binding<String> {
        Binding(
            get: { steps.indices.contains(index) ? steps[index] : "" },
            set: { value in
                guard steps.indices.contains(index) else { return }
                steps[index] = value
                reviewConfirmed = false
            }
        )
    }

    @MainActor private func loadDraft() async {
        let requestedRestaurantID = restaurantID
        let requestedItemID = itemID
        guard !requestedRestaurantID.isEmpty, !requestedItemID.isEmpty,
              CenaBackend.shared.signedIn, let userID = currentUserID else {
            loading = false
            notice = "Couldn’t open this menu item. Refresh Menu and try again."
            return
        }
        let requestID = UUID()
        draftLoadID = requestID
        loading = true
        defer { if draftLoadID == requestID { loading = false } }
        do {
            let latestItem = try await loadCatalogItem(restaurantID: requestedRestaurantID, itemID: requestedItemID)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            publishedSteps = prepSteps(latestItem["published_steps"])
            let rows = try await CenaBackend.shared.rows("prep_drafts", query: "select=id,source_steps,generated_steps,updated_at&restaurant_id=eq.\(requestedRestaurantID)&catalog_item_id=eq.\(requestedItemID)&limit=1", authenticated: true)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            if let draft = rows.first {
                draftID = prepString(draft["id"])
                updatedAt = prepString(draft["updated_at"])
                let generated = draft["generated_steps"] as? [String] ?? []
                let source = draft["source_steps"] as? [String] ?? []
                steps = !generated.isEmpty ? generated : (!source.isEmpty ? source : prepSteps(latestItem["published_steps"]))
            } else {
                draftID = nil
                updatedAt = nil
                steps = prepSteps(latestItem["published_steps"])
            }
            manualSourceConfirmed = false
            reviewConfirmed = false
            notice = nil
        } catch {
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            notice = "Couldn’t load chef steps: \(error.localizedDescription)"
        }
    }

    @MainActor private func generatePrivateDraft() async {
        guard !loading, !saving, !generating, !publishing,
              CenaBackend.shared.signedIn, let userID = currentUserID else {
            notice = "Couldn’t generate steps: sign in again and reload this draft."
            return
        }
        let requestedRestaurantID = restaurantID
        let requestedItemID = itemID
        let requestID = draftLoadID
        guard !requestedRestaurantID.isEmpty, !requestedItemID.isEmpty else { return }
        if draftID == nil && (!manualSourceConfirmed || !validSteps) {
            notice = "Couldn’t generate steps: add and confirm the first private chef source first."
            return
        }
        generating = true
        notice = nil
        defer { generating = false }
        do {
            if draftID == nil {
                await saveManualSource()
                guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
                guard draftID != nil, updatedAt != nil else { return }
            }
            guard let expectedDraftID = draftID, let expectedUpdatedAt = updatedAt else {
                throw CenaBackendError.server("Save a private chef source draft before generating steps.")
            }
            try await verifyDraftRevision(expectedID: expectedDraftID, expectedUpdatedAt: expectedUpdatedAt, restaurantID: requestedRestaurantID, itemID: requestedItemID)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID),
                  draftID == expectedDraftID, updatedAt == expectedUpdatedAt else { return }
            let generated = try await CenaBackend.shared.generatePrep(itemID: requestedItemID)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID),
                  draftID == expectedDraftID, updatedAt == expectedUpdatedAt else { return }
            let rows = try await CenaBackend.shared.rows("prep_drafts", query: "select=id,generated_steps,updated_at&restaurant_id=eq.\(requestedRestaurantID)&catalog_item_id=eq.\(requestedItemID)&id=eq.\(expectedDraftID)&limit=1", authenticated: true)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID),
                  draftID == expectedDraftID, updatedAt == expectedUpdatedAt else { return }
            guard let saved = rows.first, prepString(saved["id"]) == expectedDraftID,
                  prepString(saved["updated_at"]) == generated.updatedAt,
                  let savedSteps = saved["generated_steps"] as? [String], savedSteps == generated.steps else {
                throw CenaBackendError.conflict("The private draft changed after generation. Reload it before reviewing or publishing.")
            }
            steps = savedSteps
            updatedAt = prepString(saved["updated_at"])
            manualSourceConfirmed = false
            reviewConfirmed = false
            notice = "Private AI draft generated. Review every step before publishing."
        } catch {
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            notice = "Couldn’t generate a private draft: \(error.localizedDescription)"
        }
    }

    @MainActor private func isCurrentDraft(_ requestID: UUID, _ userID: String, _ expectedRestaurantID: String, _ expectedItemID: String) -> Bool {
        draftLoadID == requestID && currentUserID == userID && CenaBackend.shared.signedIn &&
            restaurantID == expectedRestaurantID && itemID == expectedItemID
    }

    @MainActor private func saveManualSource() async {
        guard !saving, draftID == nil, manualSourceConfirmed, validSteps else { return }
        guard CenaBackend.shared.signedIn, let userID = currentUserID else {
            notice = "Couldn’t save the private source: sign in again and reload this draft."
            return
        }
        let requestedRestaurantID = restaurantID
        let requestedItemID = itemID
        let requestID = draftLoadID
        let sourceSteps = steps.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        saving = true
        defer { saving = false }
        do {
            let latestItem = try await loadCatalogItem(restaurantID: requestedRestaurantID, itemID: requestedItemID)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            let existingDraft = try await loadDraftRevision(restaurantID: requestedRestaurantID, itemID: requestedItemID)
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            guard existingDraft == nil else { throw CenaBackendError.server("A chef draft was created elsewhere. Refresh before saving.") }
            let response = try await CenaBackend.shared.rpc("save_catalog_item_draft", body: saveBody(latestItem, restaurantID: requestedRestaurantID, itemID: requestedItemID, sourceSteps: sourceSteps))
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            guard let row = (response as? [[String: Any]])?.first,
                  let savedID = row["prep_draft_id"] as? String,
                  let savedUpdatedAt = row["draft_updated_at"] as? String else {
                throw CenaBackendError.invalidResponse
            }
            draftID = savedID
            updatedAt = savedUpdatedAt
            manualSourceConfirmed = false
            notice = "Private manual chef-step source saved."
        } catch {
            guard isCurrentDraft(requestID, userID, requestedRestaurantID, requestedItemID) else { return }
            notice = "Couldn’t save the private source: \(error.localizedDescription)"
        }
    }

    @MainActor private func publishReviewedSteps() async {
        guard !publishing, !saving, !generating, reviewConfirmed, validSteps else { return }
        publishing = true
        notice = nil
        defer { publishing = false }

        if draftID == nil || updatedAt == nil {
            guard manualSourceConfirmed else {
                notice = "Couldn’t publish: create the first private source draft and confirm authorship first."
                return
            }
            await saveManualSource()
            guard draftID != nil else { return }
        }
        guard let draftID, let updatedAt else {
            notice = "Couldn’t publish: save the private source draft first."
            return
        }
        do {
            try await verifyDraftRevision(expectedID: draftID, expectedUpdatedAt: updatedAt, restaurantID: restaurantID, itemID: itemID)
            let response = try await CenaBackend.shared.rpc("publish_prep_draft", body: [
                "p_draft_id": draftID,
                "p_expected_updated_at": updatedAt,
                "p_reviewed_steps": steps.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            ])
            reviewConfirmed = false
            let publishedItem = (response as? [String: Any]) ?? (response as? [[String: Any]])?.first
            if let active = publishedItem?["active"] as? Bool {
                notice = active
                    ? "Reviewed preparation steps published to the customer menu."
                    : "Reviewed steps published, but this menu item remains paused. Activate it in the Expo restaurant app to show it to customers."
            } else {
                notice = "Reviewed steps published. Refresh Menu to verify item availability."
            }
            publishedSteps = steps.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            await onPublished()
        } catch {
            notice = "Couldn’t publish these steps: \(error.localizedDescription). Reload the draft before retrying."
        }
    }

    private func loadCatalogItem(restaurantID: String, itemID: String) async throws -> [String: Any] {
        let rows = try await CenaBackend.shared.rows(
            "catalog_items",
            query: "select=id,name,description,price_cents,regular_price_cents,prepared_meal_total_cents,equipment,allergens,active,published_steps&restaurant_id=eq.\(restaurantID)&id=eq.\(itemID)&limit=1",
            authenticated: true
        )
        guard let latest = rows.first else { throw CenaBackendError.invalidResponse }
        return latest
    }

    private func loadDraftRevision(restaurantID: String, itemID: String) async throws -> (id: String, updatedAt: String)? {
        let rows = try await CenaBackend.shared.rows(
            "prep_drafts",
            query: "select=id,updated_at&restaurant_id=eq.\(restaurantID)&catalog_item_id=eq.\(itemID)&limit=1",
            authenticated: true
        )
        guard let row = rows.first else { return nil }
        guard let id = row["id"] as? String, let updatedAt = row["updated_at"] as? String else {
            throw CenaBackendError.invalidResponse
        }
        return (id, updatedAt)
    }

    private func verifyDraftRevision(expectedID: String, expectedUpdatedAt: String, restaurantID: String, itemID: String) async throws {
        guard let latest = try await loadDraftRevision(restaurantID: restaurantID, itemID: itemID),
              latest.id == expectedID,
              latest.updatedAt == expectedUpdatedAt else {
            throw CenaBackendError.server("This chef draft changed elsewhere. Refresh it before publishing.")
        }
    }

    private func saveBody(_ item: [String: Any], restaurantID: String, itemID: String, sourceSteps: [String]) -> [String: Any] {
        [
            "p_catalog_item_id": itemID,
            "p_restaurant_id": restaurantID,
            "p_name": prepString(item["name"]),
            "p_description": prepString(item["description"]),
            "p_price_cents": prepInt(item["price_cents"]),
            "p_regular_price_cents": item["regular_price_cents"] ?? NSNull(),
            "p_prepared_meal_total_cents": item["prepared_meal_total_cents"] ?? NSNull(),
            "p_equipment": item["equipment"] as? [String] ?? [],
            "p_allergens": item["allergens"] as? [String] ?? [],
            "p_active": item["active"] as? Bool ?? false,
            "p_source_steps": sourceSteps
        ]
    }
}

private func prepString(_ value: Any?) -> String { value as? String ?? "" }
private func prepInt(_ value: Any?) -> Int { (value as? Int) ?? ((value as? NSNumber)?.intValue ?? 0) }
private func prepSteps(_ value: Any?) -> [String] { value as? [String] ?? [] }
private func money(_ cents: Int) -> String { String(format: "%.2f", Double(cents) / 100) }
