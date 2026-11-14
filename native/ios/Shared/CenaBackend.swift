import Foundation
import SwiftUI
import Security

enum CenaBackendError: LocalizedError {
    case notConfigured, invalidResponse, server(String), conflict(String), sessionExpired
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Set SUPABASE_URL and SUPABASE_ANON_KEY at build time to connect Cena."
        case .invalidResponse: return "Cena received an invalid response. Please try again."
        case .server(let message): return message
        case .conflict(let message): return message
        case .sessionExpired: return "Your Cena sign-in expired. Sign in again to continue."
        }
    }
}

/// Small URLSession client for Supabase Auth, PostgREST, and RPC. It deliberately
/// reports connection/auth errors rather than presenting local fixtures as live data.
@MainActor final class CenaBackend: ObservableObject {
    static let shared = CenaBackend()
    @Published private(set) var accessToken: String?
    private var refreshToken: String?
    private var expiresAt: Date?
    private var sessionGeneration: UInt64 = 0
    private var refreshTask: Task<String, Error>?
    private var refreshTaskGeneration: UInt64?
    private struct StoredSession: Codable {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date?
    }
    private var keychainService: String { Bundle.main.bundleIdentifier ?? "com.cena.auth" }
    private let keychainAccount = "supabase-session"
    private let base: String? = {
        guard !ProcessInfo.processInfo.arguments.contains("--uitesting-reset"),
              let value = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String, !value.isEmpty else { return nil }
        return value
    }()
    private let key: String? = {
        guard !ProcessInfo.processInfo.arguments.contains("--uitesting-reset"),
              let value = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String, !value.isEmpty else { return nil }
        return value
    }()
    private let apiBase: String? = {
        guard !ProcessInfo.processInfo.arguments.contains("--uitesting-reset"),
              let value = Bundle.main.object(forInfoDictionaryKey: "CENA_API_URL") as? String, !value.isEmpty else { return nil }
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }()
    var configured: Bool { base != nil && key != nil }
    var paymentGatewayConfigured: Bool { apiBase != nil }
    var signedIn: Bool { accessToken != nil }

    init() {
        let defaults = UserDefaults.standard
        if ProcessInfo.processInfo.arguments.contains("--uitesting-reset") {
            deleteSecureSession()
            defaults.removeObject(forKey: "cena.accessToken")
            return
        }
        if let stored = readSecureSession() {
            accessToken = stored.accessToken; refreshToken = stored.refreshToken; expiresAt = stored.expiresAt ?? Self.jwtExpiry(stored.accessToken)
        } else if let legacyToken = defaults.string(forKey: "cena.accessToken") {
            // Migrate the previous UserDefaults session. It has no refresh token,
            // but remains usable until the access token expires or the user signs in.
            accessToken = legacyToken; expiresAt = Self.jwtExpiry(legacyToken)
            do {
                try writeSecureSession(StoredSession(accessToken: legacyToken, refreshToken: nil, expiresAt: expiresAt))
                defaults.removeObject(forKey: "cena.accessToken")
            } catch { /* Keep the legacy token so the next launch can retry migration. */ }
        }
    }

    private func readSecureSession() -> StoredSession? {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(StoredSession.self, from: data)
    }

    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: keychainService,
         kSecAttrAccount as String: keychainAccount]
    }

    private func writeSecureSession(_ session: StoredSession) throws {
        let data = try JSONEncoder().encode(session)
        let query = keychainQuery
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query; attributes.forEach { add[$0.key] = $0.value }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw CenaBackendError.server("Couldn’t save your secure sign-in session. Keychain status: " + String(addStatus) + ".") }
        } else if status != errSecSuccess {
            throw CenaBackendError.server("Couldn’t update your secure sign-in session. Keychain status: " + String(status) + ".")
        }
    }

    private func deleteSecureSession() {
        SecItemDelete(keychainQuery as CFDictionary)
    }

    private static func jwtExpiry(_ token: String) -> Date? {
        let parts = token.split(separator: ".")
        guard parts.count > 1 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = claims["exp"] as? NSNumber else { return nil }
        return Date(timeIntervalSince1970: exp.doubleValue)
    }

    private func session(from data: Data, previousRefreshToken: String? = nil) throws -> StoredSession {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = obj["access_token"] as? String else { throw CenaBackendError.invalidResponse }
        let refresh = obj["refresh_token"] as? String ?? previousRefreshToken
        let explicitExpiry = (obj["expires_at"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) }
        let durationExpiry = (obj["expires_in"] as? NSNumber).map { Date().addingTimeInterval($0.doubleValue) }
        let expiry = explicitExpiry ?? durationExpiry ?? Self.jwtExpiry(token)
        return StoredSession(accessToken: token, refreshToken: refresh, expiresAt: expiry)
    }

    private func commitSession(_ session: StoredSession, expectedGeneration: UInt64? = nil, advanceGeneration: Bool = true) throws {
        if let expectedGeneration, expectedGeneration != sessionGeneration { throw CenaBackendError.sessionExpired }
        try writeSecureSession(session)
        accessToken = session.accessToken; refreshToken = session.refreshToken; expiresAt = session.expiresAt
        if advanceGeneration { sessionGeneration &+= 1 }
    }

    private func clearSession(ifGeneration expectedGeneration: UInt64? = nil, ifAccessToken expectedToken: String? = nil) {
        if let expectedGeneration, expectedGeneration != sessionGeneration { return }
        if let expectedToken, accessToken != expectedToken { return }
        sessionGeneration &+= 1
        refreshTask?.cancel(); refreshTask = nil; refreshTaskGeneration = nil
        accessToken = nil; refreshToken = nil; expiresAt = nil
        deleteSecureSession(); UserDefaults.standard.removeObject(forKey: "cena.accessToken")
    }

    private func accessTokenForRequest() async throws -> String {
        guard let token = accessToken else { throw CenaBackendError.sessionExpired }
        guard let expiresAt else { return token }
        if expiresAt.timeIntervalSinceNow > 90 { return token }
        return try await refreshAccessToken()
    }

    private func refreshAfterUnauthorized(_ usedToken: String) async throws -> String {
        guard let current = accessToken else { throw CenaBackendError.sessionExpired }
        if current != usedToken { return current }
        guard refreshToken != nil else {
            clearSession(ifAccessToken: usedToken)
            throw CenaBackendError.sessionExpired
        }
        return try await refreshAccessToken(force: true)
    }

    private func refreshAccessToken(force: Bool = false) async throws -> String {
        guard let current = accessToken else { throw CenaBackendError.sessionExpired }
        if !force, let expiresAt, expiresAt.timeIntervalSinceNow > 90 { return current }
        guard let refreshToken, !refreshToken.isEmpty else {
            clearSession(ifAccessToken: current)
            throw CenaBackendError.sessionExpired
        }
        let generation = sessionGeneration
        let task: Task<String, Error>
        if let sharedTask = refreshTask, refreshTaskGeneration == generation {
            task = sharedTask
        } else {
            let capturedRefreshToken = refreshToken
            task = Task { [weak self] in
                guard let self else { throw CenaBackendError.sessionExpired }
                return try await self.performRefresh(capturedRefreshToken, expectedGeneration: generation)
            }
            refreshTask = task; refreshTaskGeneration = generation
        }
        do {
            let fresh = try await task.value
            guard generation == sessionGeneration else { throw CenaBackendError.sessionExpired }
            if refreshTaskGeneration == generation { refreshTask = nil; refreshTaskGeneration = nil }
            return fresh
        } catch {
            if refreshTaskGeneration == generation { refreshTask = nil; refreshTaskGeneration = nil }
            throw error
        }
    }

    private func performRefresh(_ token: String, expectedGeneration: UInt64) async throws -> String {
        guard let base, let key, let url = URL(string: base + "/auth/v1/token?grant_type=refresh_token") else { throw CenaBackendError.notConfigured }
        var request = URLRequest(url: url); request.httpMethod = "POST"
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": token])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CenaBackendError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 400 || http.statusCode == 401 {
                clearSession(ifGeneration: expectedGeneration)
                throw CenaBackendError.sessionExpired
            }
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw CenaBackendError.server((obj?["msg"] as? String) ?? (obj?["message"] as? String) ?? "Couldn’t refresh your session (HTTP \(http.statusCode)).")
        }
        guard expectedGeneration == sessionGeneration else { throw CenaBackendError.sessionExpired }
        let renewed = try session(from: data, previousRefreshToken: token)
        do { try commitSession(renewed, expectedGeneration: expectedGeneration, advanceGeneration: false) }
        catch {
            clearSession(ifGeneration: expectedGeneration)
            throw error
        }
        return renewed.accessToken
    }

    func refreshSessionIfNeeded() async throws {
        _ = try await accessTokenForRequest()
    }

    private func request(_ path: String, method: String = "GET", body: Any? = nil, authenticated: Bool = false, prefer: String? = nil) async throws -> Data {
        guard let base, let key else { throw CenaBackendError.notConfigured }
        guard let url = URL(string: base + path) else { throw CenaBackendError.server("Supabase URL is invalid.") }
        let operationGeneration = sessionGeneration
        for attempt in 0...1 {
            if authenticated && operationGeneration != sessionGeneration { throw CenaBackendError.sessionExpired }
            let bearer: String
            if authenticated { bearer = try await accessTokenForRequest() } else { bearer = key }
            if authenticated && operationGeneration != sessionGeneration { throw CenaBackendError.sessionExpired }
            let requestGeneration = sessionGeneration
            var req = URLRequest(url: url); req.httpMethod = method
            req.setValue(key, forHTTPHeaderField: "apikey")
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
            if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw CenaBackendError.invalidResponse }
            if (200..<300).contains(http.statusCode) {
                guard !authenticated || requestGeneration == sessionGeneration else { throw CenaBackendError.sessionExpired }
                return data
            }
            if authenticated && http.statusCode == 401 {
                if attempt == 0 { _ = try await refreshAfterUnauthorized(bearer); continue }
                clearSession(ifAccessToken: bearer)
                throw CenaBackendError.sessionExpired
            }
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw CenaBackendError.server((obj?["msg"] as? String) ?? (obj?["message"] as? String) ?? (obj?["error_description"] as? String) ?? (obj?["hint"] as? String) ?? "Request failed (HTTP \(http.statusCode)).")
        }
        throw CenaBackendError.invalidResponse
    }
    func rows(_ table: String, query: String, authenticated: Bool = false) async throws -> [[String: Any]] {
        let d = try await request("/rest/v1/\(table)?\(query)", authenticated: authenticated)
        return (try JSONSerialization.jsonObject(with: d)) as? [[String: Any]] ?? []
    }
    func rpc(_ name: String, body: [String: Any], authenticated: Bool = true) async throws -> Any {
        let d = try await request("/rest/v1/rpc/\(name)", method: "POST", body: body, authenticated: authenticated)
        return (try? JSONSerialization.jsonObject(with: d)) ?? [:]
    }
    func patch(_ table: String, query: String, body: [String: Any], authenticated: Bool = false) async throws -> Data {
        try await request("/rest/v1/\(table)?\(query)", method: "PATCH", body: body, authenticated: authenticated, prefer: "return=minimal")
    }
    func insert(_ table: String, body: Any, authenticated: Bool = true) async throws -> Data {
        try await request("/rest/v1/\(table)", method: "POST", body: body, authenticated: authenticated, prefer: "return=representation")
    }
    func upsert(_ table: String, query: String, body: [String: Any], authenticated: Bool = true) async throws -> Data {
        try await request("/rest/v1/\(table)?\(query)", method: "POST", body: body, authenticated: authenticated, prefer: "resolution=merge-duplicates,return=minimal")
    }
    func apiRequest(_ path: String, method: String = "GET", body: Any? = nil, authenticated: Bool = false) async throws -> Any {
        guard let apiBase, let url = URL(string: apiBase + path) else { throw CenaBackendError.server("CENA_API_URL is invalid.") }
        let operationGeneration = sessionGeneration
        for attempt in 0...1 {
            if authenticated && operationGeneration != sessionGeneration { throw CenaBackendError.sessionExpired }
            let bearer: String?
            if authenticated { bearer = try await accessTokenForRequest() } else { bearer = nil }
            if authenticated && operationGeneration != sessionGeneration { throw CenaBackendError.sessionExpired }
            let requestGeneration = sessionGeneration
            var req = URLRequest(url: url); req.httpMethod = method
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
            if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
            let (data, response) = try await URLSession.shared.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw CenaBackendError.invalidResponse }
            if (200..<300).contains(http.statusCode) {
                guard !authenticated || requestGeneration == sessionGeneration else { throw CenaBackendError.sessionExpired }
                return (try? JSONSerialization.jsonObject(with: data)) ?? [:]
            }
            if authenticated && http.statusCode == 401, let bearer {
                if attempt == 0 { _ = try await refreshAfterUnauthorized(bearer); continue }
                clearSession(ifAccessToken: bearer)
                throw CenaBackendError.sessionExpired
            }
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (obj?["error"] as? String) ?? "Cena API request failed (HTTP \(http.statusCode))."
            if http.statusCode == 409 { throw CenaBackendError.conflict(message) }
            throw CenaBackendError.server(message)
        }
        throw CenaBackendError.invalidResponse
    }
    func sendCode(email: String) async throws {
        _ = try await request("/auth/v1/otp", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), "create_user": true])
    }
    func verifyCode(email: String, code: String) async throws {
        let generation = sessionGeneration
        let d = try await request("/auth/v1/verify", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), "token": code, "type": "email"])
        guard generation == sessionGeneration else { throw CenaBackendError.sessionExpired }
        try saveSession(d, expectedGeneration: generation)
    }
    func signIn(email: String, password: String) async throws {
        let generation = sessionGeneration
        let d = try await request("/auth/v1/token?grant_type=password", method: "POST", body: ["email": email, "password": password])
        guard generation == sessionGeneration else { throw CenaBackendError.sessionExpired }
        try saveSession(d, expectedGeneration: generation)
    }
    private func saveSession(_ data: Data, expectedGeneration: UInt64) throws {
        try commitSession(session(from: data), expectedGeneration: expectedGeneration)
    }
    func signOut() { clearSession() }
    func createOrder(_ body: [String: Any]) async throws -> Any {
        if apiBase != nil { return try await apiRequest("/v1/orders", method: "POST", body: body, authenticated: true) }
        return try await rpc("create_order", body: body)
    }
    func createCheckout(_ body: [String: Any]) async throws -> [String: Any] {
        guard apiBase != nil else { throw CenaBackendError.server("Cena’s payment API is not configured. Checkout is unavailable.") }
        guard let response = try await apiRequest("/v1/checkout", method: "POST", body: body, authenticated: true) as? [String: Any],
              response["order_id"] is String,
              response["checkout_url"] is String || (response["status"] as? String)?.lowercased() == "paid" else { throw CenaBackendError.invalidResponse }
        return response
    }
    func quoteCheckout(_ body: [String: Any]) async throws -> [String: Any] {
        guard apiBase != nil else { throw CenaBackendError.server("Cena’s payment API is not configured. Price quotes are unavailable.") }
        guard let response = try await apiRequest("/v1/checkout/quote", method: "POST", body: body, authenticated: true) as? [String: Any],
              response["subtotal_cents"] is NSNumber,
              response["discount_cents"] is NSNumber,
              response["amount_cents"] is NSNumber else { throw CenaBackendError.invalidResponse }
        return response
    }
    func checkoutStatus(_ orderID: String) async throws -> String {
        guard UUID(uuidString: orderID) != nil else { throw CenaBackendError.server("Pending checkout ID is invalid.") }
        let response = try await apiRequest("/v1/checkout/\(orderID)", authenticated: true)
        guard let status = (response as? [String: Any])?["status"] as? String else { throw CenaBackendError.invalidResponse }
        return status
    }
    func cancelCheckout(_ orderID: String) async throws {
        guard UUID(uuidString: orderID) != nil else { throw CenaBackendError.server("Pending checkout ID is invalid.") }
        _ = try await apiRequest("/v1/checkout/\(orderID)", method: "DELETE", authenticated: true)
    }
    func updateOrder(_ id: String, status: String) async throws {
        if apiBase != nil { _ = try await apiRequest("/v1/orders/\(id)/status", method: "PATCH", body: ["status": status], authenticated: true) }
        else { _ = try await rpc("update_order_status", body: ["p_order_id": id, "p_status": status]) }
    }
}

enum CenaStyle {
    static let maroon = color(0x5D100A)
    static let cream = color(0xFAF6F3)
    static let ink = color(0x271D19)
    static let paper = color(0xFFFDFA)
    static let peach = color(0xFFF0E8)
    static let rose = color(0xE9CFC4)
    static let coral = color(0xC57760)
    static let clay = color(0x85574A)

    private static func color(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255)
    }
}

extension View {
    /// Corners become progressively rounder below the 390pt iPhone baseline.
    func cenaCardBackground(_ color: Color, outline: Color? = nil) -> some View {
        background {
            GeometryReader { geometry in
                let radius = min(26, max(18, 18 + (390 - geometry.size.width) * 0.06))
                RoundedRectangle(cornerRadius: radius, style: .continuous).fill(color)
                    .overlay { if let outline { RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(outline, lineWidth: 1) } }
            }
        }
    }
}

struct CenaNotice: View {
    let message: String
    let dismiss: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill").foregroundStyle(CenaStyle.clay)
            Text(message).font(.subheadline).foregroundStyle(CenaStyle.ink).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(CenaStyle.clay) }.accessibilityLabel("Dismiss message")
        }
        .padding(14).cenaCardBackground(CenaStyle.peach, outline: CenaStyle.rose)
        .shadow(color: .black.opacity(0.08), radius: 12, y: 5)
    }
}
