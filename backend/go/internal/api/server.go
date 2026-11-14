package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxBody = 64 << 10

type Config struct {
	SupabaseURL, SupabaseAnonKey string
	SupabaseServiceRoleKey       string
	AllowedOrigins               []string
	Client                       *http.Client
	GeocoderClient               *http.Client
	StripeClient                 *http.Client
	StripeAPIBaseURL             string
	StripeSecretKey              string
	StripeWebhookSecret          string
	ApplicationFeeCents          int
	WebBaseURL                   string
}
type Server struct {
	cfg            Config
	client         *http.Client
	geocoderClient *http.Client
	stripeClient   *http.Client
	mux            *http.ServeMux
}

func New(cfg Config) http.Handler {
	return NewServer(cfg).Handler()
}

// NewServer constructs the HTTP API and its background checkout reconciler dependencies.
func NewServer(cfg Config) *Server {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.SupabaseURL), "/"))
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" {
		panic("invalid Supabase URL")
	}
	cfg.SupabaseURL = strings.TrimRight(cfg.SupabaseURL, "/")
	c := cfg.Client
	if c == nil {
		c = &http.Client{Timeout: 8 * time.Second}
	}
	gc := cfg.GeocoderClient
	if gc == nil {
		gc = &http.Client{Timeout: 4 * time.Second}
	}
	sc := cfg.StripeClient
	if sc == nil {
		sc = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.ApplicationFeeCents == 0 {
		cfg.ApplicationFeeCents = 175
	}
	if cfg.ApplicationFeeCents < 150 || cfg.ApplicationFeeCents > 200 {
		panic("STRIPE_APPLICATION_FEE_CENTS must be from 150 to 200")
	}
	if cfg.StripeAPIBaseURL == "" {
		cfg.StripeAPIBaseURL = "https://api.stripe.com"
	}
	if err := validateStripeAPIBaseURL(cfg.StripeAPIBaseURL, cfg.StripeSecretKey); err != nil {
		panic(err)
	}
	if cfg.WebBaseURL != "" {
		web, parseErr := url.Parse(cfg.WebBaseURL)
		if parseErr != nil || (web.Scheme != "https" && web.Scheme != "http") || web.Host == "" || web.User != nil || web.RawQuery != "" || web.Fragment != "" {
			panic("CENA_WEB_BASE_URL must be an http(s) origin or base path")
		}
		cfg.WebBaseURL = strings.TrimRight(cfg.WebBaseURL, "/")
	}
	s := &Server{cfg: cfg, client: c, geocoderClient: gc, stripeClient: sc, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /healthz", s.health)
	s.mux.HandleFunc("GET /v1/geocode", s.geocode)
	s.mux.HandleFunc("GET /v1/catalog", s.catalog)
	s.mux.HandleFunc("POST /v1/discovery", s.discovery)
	s.mux.HandleFunc("POST /v1/orders", s.createOrder)
	s.mux.HandleFunc("PATCH /v1/orders/{id}/status", s.updateOrderStatus)
	s.mux.HandleFunc("POST /v1/checkout", s.startCheckout)
	s.mux.HandleFunc("POST /v1/checkout/quote", s.quoteCheckout)
	s.mux.HandleFunc("GET /v1/checkout/{id}", s.checkoutStatus)
	s.mux.HandleFunc("DELETE /v1/checkout/{id}", s.cancelCheckout)
	s.mux.HandleFunc("POST /v1/stripe/webhook", s.stripeWebhook)
	s.mux.HandleFunc("POST /v1/analytics/events", s.trackEvent)
	s.registerConnectRoutes()
	s.registerRefundRoutes()
	return s
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		allowed := origin != "" && s.originAllowed(origin)
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if origin != "" && !allowed {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
				return
			}
			if allowed {
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.Header().Set("Access-Control-Max-Age", "600")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	origins := s.cfg.AllowedOrigins
	if len(origins) == 0 {
		origins = []string{"http://localhost:8081", "http://localhost:8082", "http://127.0.0.1:8081", "http://127.0.0.1:8082"}
	}
	for _, candidate := range origins {
		if strings.TrimSpace(candidate) == origin {
			return true
		}
	}
	return false
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]string{"status": "ok"})
}
func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	// The query parameters are fixed server-side; caller filters cannot broaden table access.
	paths := []string{
		"restaurants?select=id,slug,name,cuisine,image_key,description,address,timezone,curbside_enabled&active=eq.true&order=name&limit=200",
		"catalog_items?select=id,restaurant_id,name,description,price_cents,regular_price_cents,prepared_meal_total_cents,equipment,allergens,published_steps,image_key,category,prep_minutes&active=eq.true&published_at=not.is.null&order=name&limit=1000",
		"pickup_slots?select=id,restaurant_id,starts_at,ends_at,cutoff_at,capacity,reserved_count&active=eq.true&starts_at=gt." + url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano)) + "&cutoff_at=gt." + url.QueryEscape(time.Now().UTC().Format(time.RFC3339Nano)) + "&order=starts_at&limit=1000",
		"slot_item_inventory?select=slot_id,item_id,available_qty,reserved_qty&limit=5000",
	}
	result := make([]json.RawMessage, len(paths))
	for i, p := range paths {
		b, status, err := s.supabase(r, http.MethodGet, "/rest/v1/"+p, nil)
		if err != nil {
			upstreamError(w, status, err)
			return
		}
		if !json.Valid(b) {
			writeJSON(w, 502, map[string]string{"error": "invalid response from data service"})
			return
		}
		result[i] = b
	}
	writeJSON(w, 200, map[string]json.RawMessage{"restaurants": result[0], "items": result[1], "slots": result[2], "inventory": result[3]})
}

type discoveryRequest struct {
	Latitude  *float64 `json:"p_latitude"`
	Longitude *float64 `json:"p_longitude"`
	After     *string  `json:"p_after"`
	Query     *string  `json:"p_query"`
	Cuisine   *string  `json:"p_cuisine"`
	RecentIDs []string `json:"p_recent_ids"`
}

func (s *Server) discovery(w http.ResponseWriter, r *http.Request) {
	var in discoveryRequest
	if !decodeBody(w, r, &in) {
		return
	}
	if (in.Latitude == nil) != (in.Longitude == nil) {
		writeJSON(w, 400, map[string]string{"error": "latitude and longitude must be provided together"})
		return
	}
	if in.Latitude != nil && (math.IsNaN(*in.Latitude) || math.IsInf(*in.Latitude, 0) || math.IsNaN(*in.Longitude) || math.IsInf(*in.Longitude, 0) || *in.Latitude < -90 || *in.Latitude > 90 || *in.Longitude < -180 || *in.Longitude > 180) {
		writeJSON(w, 400, map[string]string{"error": "coordinates are out of range"})
		return
	}
	if tooLong(in.After, 500) || tooLong(in.Query, 120) || tooLong(in.Cuisine, 80) || len(in.RecentIDs) > 30 {
		writeJSON(w, 400, map[string]string{"error": "discovery filters exceed allowed size"})
		return
	}
	if in.RecentIDs == nil {
		in.RecentIDs = []string{}
	}
	s.rpcOptionalAuth(w, r, "discover_pickup_feed", map[string]any{
		"p_latitude": in.Latitude, "p_longitude": in.Longitude, "p_after": in.After,
		"p_query": in.Query, "p_cuisine": in.Cuisine, "p_recent_ids": in.RecentIDs,
	})
}

func tooLong(v *string, n int) bool { return v != nil && len(*v) > n }

type orderRequest struct {
	RestaurantID        string          `json:"p_restaurant_id"`
	SlotID              string          `json:"p_slot_id"`
	IdempotencyKey      string          `json:"p_idempotency_key"`
	PickupMode          string          `json:"p_pickup_mode"`
	Vehicle             json.RawMessage `json:"p_vehicle"`
	Items               json.RawMessage `json:"p_items"`
	PromoCode           string          `json:"promo_code"`
	ExpectedAmountCents *int            `json:"expected_amount_cents"`
}

func (s *Server) createOrder(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusGone, map[string]string{"error": "online payment is required; use /v1/checkout"})
}
func (s *Server) updateOrderStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || len(id) > 64 {
		writeJSON(w, 400, map[string]string{"error": "invalid order id"})
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.Status == "" {
		writeJSON(w, 400, map[string]string{"error": "status is required"})
		return
	}
	body := map[string]string{"p_order_id": id, "p_status": in.Status}
	s.rpc(w, r, "update_order_status", body)
}
func (s *Server) trackEvent(w http.ResponseWriter, r *http.Request) {
	var in struct {
		EventType    string          `json:"event_type"`
		RestaurantID *string         `json:"restaurant_id"`
		Payload      json.RawMessage `json:"payload"`
	}
	if !decodeBody(w, r, &in) {
		return
	}
	if in.EventType == "" {
		writeJSON(w, 400, map[string]string{"error": "event_type is required"})
		return
	}
	if len(in.Payload) == 0 {
		in.Payload = json.RawMessage(`{}`)
	}
	if !json.Valid(in.Payload) {
		writeJSON(w, 400, map[string]string{"error": "payload must be JSON"})
		return
	}
	var rid any
	if in.RestaurantID != nil {
		rid = *in.RestaurantID
	}
	body := map[string]any{"p_event_type": in.EventType, "p_restaurant_id": rid, "p_payload": in.Payload}
	s.rpc(w, r, "track_event", body)
}
func (s *Server) rpc(w http.ResponseWriter, r *http.Request, name string, body any) {
	if _, ok := bearerToken(r); !ok {
		writeJSON(w, 401, map[string]string{"error": "authentication required"})
		return
	}
	s.callRPC(w, r, name, body)
}

func (s *Server) rpcOptionalAuth(w http.ResponseWriter, r *http.Request, name string, body any) {
	if auth := strings.TrimSpace(r.Header.Get("Authorization")); auth != "" {
		if _, ok := bearerToken(r); !ok {
			writeJSON(w, 401, map[string]string{"error": "invalid authorization header"})
			return
		}
	}
	s.callRPC(w, r, name, body)
}

func (s *Server) callRPC(w http.ResponseWriter, r *http.Request, name string, body any) {
	b, err := json.Marshal(body)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid request"})
		return
	}
	out, status, err := s.supabase(r, http.MethodPost, "/rest/v1/rpc/"+name, b)
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	if !json.Valid(out) {
		writeJSON(w, 502, map[string]string{"error": "invalid response from data service"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(out)
}
func (s *Server) supabase(in *http.Request, method, path string, body []byte) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(in.Context(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, s.cfg.SupabaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, 502, err
	}
	req.Header.Set("apikey", s.cfg.SupabaseAnonKey)
	req.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	// Forward only a syntactically valid Bearer token; never substitute privileged credentials.
	if token, ok := bearerToken(in); ok {
		req.Header.Set("Authorization", "Bearer "+token)
	} else if strings.TrimSpace(in.Header.Get("Authorization")) != "" {
		return nil, 401, errors.New("invalid authorization header")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, 502, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, 502, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return b, resp.StatusCode, errors.New("upstream request failed")
	}
	return b, resp.StatusCode, nil
}
func bearerToken(r *http.Request) (string, bool) {
	parts := strings.Fields(strings.TrimSpace(r.Header.Get("Authorization")))
	returnToken := ""
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && len(parts[1]) <= 8192 {
		returnToken = parts[1]
	}
	return returnToken, returnToken != ""
}
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON body"})
		return false
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		writeJSON(w, 400, map[string]string{"error": "request must contain one JSON object"})
		return false
	}
	return true
}
func upstreamError(w http.ResponseWriter, status int, err error) {
	if status == 401 {
		writeJSON(w, 401, map[string]string{"error": "authentication required or invalid"})
		return
	}
	if status == 403 {
		writeJSON(w, 403, map[string]string{"error": "not authorized"})
		return
	}
	if status == 502 {
		writeJSON(w, 502, map[string]string{"error": "data service unavailable"})
		return
	}
	if status >= 400 && status < 500 {
		writeJSON(w, 422, map[string]string{"error": "request rejected by data service"})
		return
	}
	writeJSON(w, 502, map[string]string{"error": "data service unavailable"})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
