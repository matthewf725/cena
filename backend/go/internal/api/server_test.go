package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
func TestDirectOrderEndpointDisabledForOnlineCheckout(t *testing.T) {
	h := newTestAPI(t, func(w http.ResponseWriter, r *http.Request) { t.Fatal("legacy order endpoint must not call Supabase") })
	r := httptest.NewRequest("POST", "/v1/orders", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusGone || !strings.Contains(w.Body.String(), "/v1/checkout") {
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
		if strings.Contains(r.URL.Path, "catalog_items") && !strings.Contains(r.URL.Query().Get("select"), "prepared_meal_total_cents") {
			t.Errorf("prepared meal total missing from catalog projection")
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

func TestGeocodeUsesCensusAndReturnsCaliforniaCoordinates(t *testing.T) {
	calls := 0
	geocoder := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "geocoding.geo.census.gov" || r.URL.Path != "/geocoder/locations/onelineaddress" {
			t.Errorf("unexpected geocoder target: %s", r.URL)
		}
		if r.URL.Query().Get("address") != "420 Mission Street, San Francisco, CA 94105" || r.URL.Query().Get("format") != "json" || r.URL.Query().Get("benchmark") != "Public_AR_Current" {
			t.Errorf("unexpected Census parameters: %s", r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected credentials sent to Census")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"result":{"addressMatches":[{"matchedAddress":"420 MISSION ST, SAN FRANCISCO, CA, 94105","coordinates":{"x":-122.3967,"y":37.7909},"addressComponents":{"state":"CA"}}]}}`))}, nil
	})}
	h := New(Config{SupabaseURL: "http://127.0.0.1", SupabaseAnonKey: "x", GeocoderClient: geocoder})
	address := "420 Mission Street, San Francisco, CA 94105"
	r := httptest.NewRequest("GET", "/v1/geocode?address="+url.QueryEscape(address), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["label"] != "420 MISSION ST, SAN FRANCISCO, CA, 94105" || got["latitude"] != 37.7909 || got["longitude"] != -122.3967 {
		t.Fatalf("unexpected public geocode response: %#v", got)
	}
}

func TestGeocodeValidatesInputAndRestrictsCaliforniaResults(t *testing.T) {
	calls := 0
	geocoder := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		body := `{"result":{"addressMatches":[{"matchedAddress":"1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500","coordinates":{"x":-77.0365,"y":38.8977},"addressComponents":{"state":"DC"}}]}}`
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	h := New(Config{SupabaseURL: "http://127.0.0.1", SupabaseAnonKey: "x", GeocoderClient: geocoder})
	for _, target := range []string{"/v1/geocode", "/v1/geocode?address=short", "/v1/geocode?address=123%20Main%20St%0ASeattle%20WA", "/v1/geocode?address=123%20Main%20Street&address=456%20Second%20Street"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", target, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s returned %d %s", target, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/geocode?address="+url.QueryEscape("1600 Pennsylvania Ave NW, Washington, DC 20500"), nil))
	if w.Code != http.StatusUnprocessableEntity || calls != 1 || strings.Contains(w.Body.String(), "1600 PENNSYLVANIA") {
		t.Fatalf("out-of-scope response=%d calls=%d body=%s", w.Code, calls, w.Body.String())
	}
}
