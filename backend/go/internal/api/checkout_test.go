package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStartCheckoutUsesVerifiedUserPriceAndConnectedAccount(t *testing.T) {
	orderID := "550e8400-e29b-41d4-a716-446655440000"
	userID := "650e8400-e29b-41d4-a716-446655440000"
	expires := time.Unix(time.Now().Add(31*time.Minute).Unix(), 0).UTC()
	var orderReservation map[string]any
	var recorded bool
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "supabase.test" {
			switch r.URL.Path {
			case "/auth/v1/user":
				if r.Header.Get("Authorization") != "Bearer user-jwt" {
					t.Errorf("Auth token was not forwarded")
				}
				return jsonResponse(http.StatusOK, `{"id":"`+userID+`","email":"buyer@example.com"}`), nil
			case "/rest/v1/rpc/reserve_checkout_order":
				if r.Header.Get("apikey") != "service-role" {
					t.Errorf("reserve RPC did not use service role")
				}
				_ = json.NewDecoder(r.Body).Decode(&orderReservation)
				if orderReservation["p_user_id"] != userID {
					t.Errorf("unverified user id: %#v", orderReservation["p_user_id"])
				}
				if orderReservation["p_expected_amount_cents"] != float64(2599) || orderReservation["p_promo_code"] != nil {
					t.Errorf("expected quote and empty promotion were not forwarded: %#v", orderReservation)
				}
				out, _ := json.Marshal(checkoutReservation{OrderID: orderID, AmountCents: 2599, SubtotalCents: 2599, Currency: "usd", ApplicationFeeCents: 175, StripeAccountID: "acct_test123", ExpiresAt: expires, Status: "pending"})
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(out)))}, nil
			case "/rest/v1/rpc/record_checkout_session":
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["p_session_id"] != "cs_test_123" || body["p_amount_cents"] != float64(2599) {
					t.Errorf("session was not recorded with reserved amount: %#v", body)
				}
				recorded = true
				return jsonResponse(http.StatusOK, `{}`), nil
			}
		}
		if r.URL.Host == "api.stripe.com" {
			switch r.URL.Path {
			case "/v1/accounts/acct_test123":
				return jsonResponse(http.StatusOK, `{"id":"acct_test123","charges_enabled":true,"payouts_enabled":true}`), nil
			case "/v1/checkout/sessions":
				if r.Header.Get("Stripe-Account") != "acct_test123" {
					t.Errorf("missing connected account header")
				}
				if r.Header.Get("Idempotency-Key") != "cena-checkout-"+orderID {
					t.Errorf("wrong stable idempotency key: %q", r.Header.Get("Idempotency-Key"))
				}
				fields, _ := url.ParseQuery(readBody(r))
				if fields.Get("line_items[0][price_data][unit_amount]") != "2599" || fields.Get("payment_intent_data[application_fee_amount]") != "175" {
					t.Errorf("caller price/fee mismatch: %v", fields)
				}
				exp, _ := strconv.ParseInt(fields.Get("expires_at"), 10, 64)
				session := checkoutSession{ID: "cs_test_123", URL: "https://checkout.stripe.com/c/pay/cs_test_123", Status: "open", AmountTotal: 2599, Currency: "usd", ClientReferenceID: orderID, ExpiresAt: exp, Metadata: map[string]string{"order_id": orderID, "cena_order_id": orderID, "application_fee_cents": "175"}, PaymentMethodTypes: []string{"card"}}
				out, _ := json.Marshal(session)
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(out)))}, nil
			}
		}
		t.Errorf("unexpected request %s %s", r.Method, r.URL)
		return jsonResponse(http.StatusNotFound, `{}`), nil
	})}
	h := New(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role", StripeSecretKey: "sk_test_fake", StripeWebhookSecret: "whsec_fake", WebBaseURL: "https://cena.example", Client: client, StripeClient: client})
	body := `{"p_restaurant_id":"` + userID + `","p_slot_id":"` + orderID + `","p_idempotency_key":"checkout-12345678","p_pickup_mode":"counter","p_items":[{"item_id":"` + orderID + `","quantity":1}],"expected_amount_cents":2599}`
	r := httptest.NewRequest(http.MethodPost, "/v1/checkout", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer user-jwt")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response["order_id"] != orderID || response["checkout_url"] != "https://checkout.stripe.com/c/pay/cs_test_123" || !recorded || orderReservation["p_idempotency_key"] != "checkout-12345678" {
		t.Fatalf("response=%#v recorded=%v reservation=%#v", response, recorded, orderReservation)
	}
}

func TestQuoteCheckoutUsesVerifiedUserAndReturnsDatabasePrice(t *testing.T) {
	orderID := "550e8400-e29b-41d4-a716-446655440000"
	userID := "650e8400-e29b-41d4-a716-446655440000"
	var rpc map[string]any
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "supabase.test" {
			t.Fatalf("unexpected external request: %s", r.URL)
		}
		switch r.URL.Path {
		case "/auth/v1/user":
			if r.Header.Get("Authorization") != "Bearer user-jwt" {
				t.Errorf("missing caller token")
			}
			return jsonResponse(http.StatusOK, `{"id":"`+userID+`"}`), nil
		case "/rest/v1/rpc/quote_checkout_order":
			if r.Header.Get("apikey") != "service-role" {
				t.Errorf("quote must use service credentials")
			}
			_ = json.NewDecoder(r.Body).Decode(&rpc)
			return jsonResponse(http.StatusOK, `{"restaurant_id":"`+userID+`","slot_id":"`+orderID+`","subtotal_cents":5000,"discount_cents":1000,"amount_cents":4000,"currency":"usd","promo_code":"SAVE20","discount_percent":20}`), nil
		default:
			t.Fatalf("unexpected request path %s", r.URL.Path)
			return nil, nil
		}
	})}
	h := New(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role", StripeSecretKey: "sk_test_fake", StripeWebhookSecret: "whsec_fake", WebBaseURL: "https://cena.example", Client: client})
	body := `{"p_restaurant_id":"` + userID + `","p_slot_id":"` + orderID + `","p_items":[{"item_id":"` + orderID + `","quantity":2}],"promo_code":" save20 "}`
	r := httptest.NewRequest(http.MethodPost, "/v1/checkout/quote", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer user-jwt")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if rpc["p_user_id"] != userID || rpc["p_promo_code"] != "SAVE20" || rpc["p_slot_id"] != orderID {
		t.Fatalf("quote RPC args %#v", rpc)
	}
	var got checkoutQuote
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || !validQuote(got, userID, orderID) || got.AmountCents != 4000 {
		t.Fatalf("invalid returned quote: %#v, err=%v", got, err)
	}
}

func TestCheckoutAndQuoteRequireVerifiedBearerBeforeCallingServices(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Fatalf("unauthenticated request reached upstream: %s", r.URL)
		return nil, nil
	})}
	h := New(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role", StripeSecretKey: "sk_test_fake", StripeWebhookSecret: "whsec_fake", WebBaseURL: "https://cena.example", Client: client})
	for _, endpoint := range []string{"/v1/checkout", "/v1/checkout/quote"} {
		r := httptest.NewRequest(http.MethodPost, endpoint, strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s: got %d, want 401: %s", endpoint, w.Code, w.Body.String())
		}
	}
}

func readBody(r *http.Request) string { b, _ := io.ReadAll(r.Body); return string(b) }
func jsonResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}
