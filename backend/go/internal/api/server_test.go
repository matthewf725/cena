package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestAPI(t *testing.T, upstream http.HandlerFunc) http.Handler {
	t.Helper()
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)
	return New(Config{SupabaseURL: up.URL, SupabaseAnonKey: "public-test-key", Client: up.Client()})
}
func TestHealthz(t *testing.T) {
	h := New(Config{SupabaseURL: "http://127.0.0.1", SupabaseAnonKey: "x"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"ok"`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
func TestCORSExactDefaultsAndPreflight(t *testing.T) {
	h := New(Config{SupabaseURL: "http://127.0.0.1", SupabaseAnonKey: "x"})
	r := httptest.NewRequest("OPTIONS", "/v1/orders", nil)
	r.Header.Set("Origin", "http://localhost:8081")
	r.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "http://localhost:8081" || w.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" {
		t.Fatalf("%d %#v", w.Code, w.Header())
	}
}
func TestCORSRejectsUnlistedOriginAndSupportsOverride(t *testing.T) {
	h := New(Config{SupabaseURL: "http://127.0.0.1", SupabaseAnonKey: "x", AllowedOrigins: []string{"https://app.example"}})
	r := httptest.NewRequest("OPTIONS", "/v1/orders", nil)
	r.Header.Set("Origin", "http://localhost:8081")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("unlisted origin: %d", w.Code)
	}
	r = httptest.NewRequest("OPTIONS", "/v1/orders", nil)
	r.Header.Set("Origin", "https://app.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "https://app.example" {
		t.Fatalf("override: %d %#v", w.Code, w.Header())
	}
}

func TestDiscoveryForwardsOptionalAnonymousFilters(t *testing.T) {
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/v1/rpc/discover_pickup_feed" {
			t.Errorf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected auth header %q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["p_latitude"] != 37.7 || body["p_longitude"] != -122.4 || body["p_query"] != "pasta" {
			t.Errorf("RPC args: %#v", body)
		}
		if _, ok := body["p_recent_ids"].([]any); !ok {
			t.Errorf("recent IDs should be an array: %#v", body)
		}
		io.WriteString(w, `{"recent":[],"explore":[],"nearby":[],"categories":[],"next_cursor":null}`)
	})
	r := httptest.NewRequest("POST", "/v1/discovery", strings.NewReader(`{"p_latitude":37.7,"p_longitude":-122.4,"p_query":"pasta"}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"explore":[]`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestDiscoveryForwardsOptionalBearerAndValidatesCoordinates(t *testing.T) {
	calls := 0
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer user-jwt" {
			t.Errorf("auth not forwarded: %q", r.Header.Get("Authorization"))
		}
		io.WriteString(w, `{"recent":[],"explore":[],"nearby":[],"categories":[],"next_cursor":null}`)
	})
	r := httptest.NewRequest("POST", "/v1/discovery", strings.NewReader(`{"p_latitude":37,"p_longitude":-122}`))
	r.Header.Set("Authorization", "Bearer user-jwt")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || calls != 1 {
		t.Fatalf("%d calls=%d", w.Code, calls)
	}
	r = httptest.NewRequest("POST", "/v1/discovery", strings.NewReader(`{"p_latitude":91,"p_longitude":-122}`))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || calls != 1 {
		t.Fatalf("invalid coords: %d calls=%d", w.Code, calls)
	}
	r = httptest.NewRequest("POST", "/v1/discovery", strings.NewReader(`{"p_latitude":37}`))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 || calls != 1 {
		t.Fatalf("incomplete coords: %d calls=%d", w.Code, calls)
	}
}
func TestCreateOrderForwardsUserTokenAndRPCContract(t *testing.T) {
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/v1/rpc/create_order" {
			t.Errorf("path %s", r.URL.Path)
		}
		if r.Header.Get("apikey") != "public-test-key" {
			t.Errorf("apikey missing")
		}
		if r.Header.Get("Authorization") != "Bearer user-jwt" {
			t.Errorf("auth not forwarded: %q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["p_idempotency_key"] != "abcdefgh" || body["p_pickup_mode"] != "counter" {
			t.Errorf("RPC args: %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"order-1","status":"placed"}`)
	})
	body := `{"p_restaurant_id":"r","p_slot_id":"s","p_idempotency_key":"abcdefgh","p_pickup_mode":"counter","p_items":[{"item_id":"i","quantity":1}]}`
	r := httptest.NewRequest("POST", "/v1/orders", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer user-jwt")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"order-1"`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
func TestWriteRequiresBearer(t *testing.T) {
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("upstream should not be called") })
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/v1/analytics/events", strings.NewReader(`{"event_type":"search"}`)))
	if w.Code != 401 {
		t.Fatalf("got %d", w.Code)
	}
}
func TestCatalogUsesFixedSafeReads(t *testing.T) {
	count := 0
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) {
		count++
		if r.Method != "GET" || r.Header.Get("apikey") != "public-test-key" {
			t.Errorf("unexpected upstream request")
		}
		if strings.Contains(r.URL.RawQuery, "drop") {
			t.Errorf("caller query leaked")
		}
		io.WriteString(w, "[]")
	})
	r := httptest.NewRequest("GET", "/v1/catalog?drop=table", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || count != 4 {
		t.Fatalf("status %d count %d body %s", w.Code, count, w.Body.String())
	}
}
