import Foundation
import SwiftUI

enum CenaBackendError: LocalizedError {
    case notConfigured, invalidResponse, server(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Set SUPABASE_URL and SUPABASE_ANON_KEY at build time to connect Cena."
        case .invalidResponse: return "Cena received an invalid response. Please try again."
        case .server(let message): return message
        }
    }
}

/// Small URLSession client for Supabase Auth, PostgREST, and RPC. It deliberately
/// reports connection/auth errors rather than presenting local fixtures as live data.
@MainActor final class CenaBackend: ObservableObject {
    static let shared = CenaBackend()
    @Published private(set) var accessToken: String? = UserDefaults.standard.string(forKey: "cena.accessToken")
    private let base: String? = (Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String).flatMap { $0.isEmpty ? nil : $0 }
    private let key: String? = (Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String).flatMap { $0.isEmpty ? nil : $0 }
    private let apiBase: String? = (Bundle.main.object(forInfoDictionaryKey: "CENA_API_URL") as? String).flatMap { $0.isEmpty ? nil : $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
    var configured: Bool { base != nil && key != nil }
    var signedIn: Bool { accessToken != nil }

    private func request(_ path: String, method: String = "GET", body: Any? = nil, authenticated: Bool = false, prefer: String? = nil) async throws -> Data {
        guard let base, let key else { throw CenaBackendError.notConfigured }
        guard let url = URL(string: base + path) else { throw CenaBackendError.server("Supabase URL is invalid.") }
        var req = URLRequest(url: url); req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(authenticated ? (accessToken ?? key) : key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw CenaBackendError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw CenaBackendError.server((obj?["msg"] as? String) ?? (obj?["message"] as? String) ?? (obj?["error_description"] as? String) ?? (obj?["hint"] as? String) ?? "Request failed (HTTP \(http.statusCode)).")
        }
        return data
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
    func apiRequest(_ path: String, method: String = "GET", body: Any? = nil, authenticated: Bool = false) async throws -> Any {
        guard let apiBase, let url = URL(string: apiBase + path) else { throw CenaBackendError.server("CENA_API_URL is invalid.") }
        var req = URLRequest(url: url); req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated {
            guard let accessToken else { throw CenaBackendError.server("Sign in to continue.") }
            req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw CenaBackendError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw CenaBackendError.server((obj?["error"] as? String) ?? "Cena API request failed (HTTP \(http.statusCode)).")
        }
        return (try? JSONSerialization.jsonObject(with: data)) ?? [:]
    }
    func sendCode(email: String) async throws {
        _ = try await request("/auth/v1/otp", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), "create_user": true])
    }
    func verifyCode(email: String, code: String) async throws {
        let d = try await request("/auth/v1/verify", method: "POST", body: ["email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), "token": code, "type": "email"])
        try saveSession(d)
    }
    func signIn(email: String, password: String) async throws {
        let d = try await request("/auth/v1/token?grant_type=password", method: "POST", body: ["email": email, "password": password])
        try saveSession(d)
    }
    private func saveSession(_ data: Data) throws {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = obj["access_token"] as? String else { throw CenaBackendError.invalidResponse }
        accessToken = token; UserDefaults.standard.set(token, forKey: "cena.accessToken")
    }
    func signOut() { accessToken = nil; UserDefaults.standard.removeObject(forKey: "cena.accessToken") }
    func createOrder(_ body: [String: Any]) async throws -> Any {
        if apiBase != nil { return try await apiRequest("/v1/orders", method: "POST", body: body, authenticated: true) }
        return try await rpc("create_order", body: body)
    }
    func updateOrder(_ id: String, status: String) async throws {
        if apiBase != nil { _ = try await apiRequest("/v1/orders/\(id)/status", method: "PATCH", body: ["status": status], authenticated: true) }
        else { _ = try await rpc("update_order_status", body: ["p_order_id": id, "p_status": status]) }
    }
}

enum CenaStyle {
    static let maroon = Color(red: 0x5D/255, green: 0x10/255, blue: 0x0A/255)
    static let cream = Color(red: 0xFA/255, green: 0xF6/255, blue: 0xF3/255)
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
            Image(systemName: "info.circle.fill").foregroundStyle(CenaStyle.maroon)
            Text(message).font(.subheadline).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
            Button(action: dismiss) { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary) }
        }
        .padding(14).cenaCardBackground(.white)
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(CenaStyle.maroon.opacity(0.18), lineWidth: 1) }
        .shadow(color: .black.opacity(0.08), radius: 12, y: 5)
    }
}
