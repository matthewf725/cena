package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConnectOnboardingChecksMembershipAndStoresFee(t *testing.T) {
	const restaurantID = "10000000-0000-4000-8000-000000000001"
	var mapping restaurantPaymentAccount
	var stripeRequests int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rest/v1/merchant_memberships":
			if r.URL.Query().Get("restaurant_id") != "eq."+restaurantID {
				t.Errorf("incorrect restaurant membership filter")
			}
			if r.Header.Get("Authorization") == "Bearer owner-token" {
				io.WriteString(w, `[{"role":"owner"}]`)
			} else {
				io.WriteString(w, `[]`)
			}
		case "/rest/v1/restaurant_payment_accounts":
			if r.Header.Get("apikey") != "service-key" || r.Header.Get("Authorization") != "Bearer service-key" {
				t.Errorf("private account storage was not called as service role")
			}
			if r.Method == http.MethodPost {
				if err := json.NewDecoder(r.Body).Decode(&mapping); err != nil {
					t.Errorf("invalid mapping: %v", err)
				}
				w.WriteHeader(http.StatusCreated)
				return
			}
			if r.Method == http.MethodPatch {
				var flags connectAccount
				if err := json.NewDecoder(r.Body).Decode(&flags); err != nil || !flags.ChargesEnabled || !flags.PayoutsEnabled ||
					r.URL.Query().Get("stripe_account_id") != "eq.acct_Test" {
					t.Errorf("unexpected readiness update")
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if mapping.StripeID == "" {
				io.WriteString(w, `[]`)
				return
			}
			json.NewEncoder(w).Encode([]restaurantPaymentAccount{mapping})
		case "/v1/accounts":
			stripeRequests++
			r.ParseForm()
			if r.Form.Get("controller[stripe_dashboard][type]") != "full" || r.Form.Get("controller[fees][payer]") != "account" ||
				r.Form.Get("metadata[cena_restaurant_id]") != restaurantID ||
				r.Header.Get("Idempotency-Key") != "cena-restaurant-"+restaurantID {
				t.Errorf("unexpected Stripe account creation request")
			}
			io.WriteString(w, `{"id":"acct_Test"}`)
		case "/v1/account_links":
			stripeRequests++
			r.ParseForm()
			if r.Form.Get("account") != "acct_Test" || r.Form.Get("refresh_url") != "https://cena.example/restaurant/connect/refresh" ||
				r.Form.Get("return_url") != "https://cena.example/restaurant/connect/return" {
				t.Errorf("unexpected Stripe onboarding parameters")
			}
			io.WriteString(w, `{"url":"https://connect.stripe.com/setup/test"}`)
		case "/v1/accounts/acct_Test":
			stripeRequests++
			io.WriteString(w, `{"id":"acct_Test","charges_enabled":true,"payouts_enabled":true}`)
		default:
			t.Errorf("unexpected upstream route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()
	api := New(Config{SupabaseURL: upstream.URL, SupabaseAnonKey: "public-key", SupabaseServiceRoleKey: "service-key",
		StripeSecretKey: "sk_test_fixture", StripeWebhookSecret: "whsec_fixture", StripeAPIBaseURL: upstream.URL,
		WebBaseURL: "https://cena.example", ApplicationFeeCents: 175})
	request := func(method, resource, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/v1/restaurants/"+restaurantID+resource, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		api.ServeHTTP(response, r)
		return response
	}
	if got := request(http.MethodPost, "/stripe-onboarding", "outsider"); got.Code != http.StatusForbidden || stripeRequests != 0 {
		t.Fatalf("unauthorized onboarding reached Stripe: %d %d", got.Code, stripeRequests)
	}
	if got := request(http.MethodGet, "/payments", "owner-token"); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"not_connected"`) {
		t.Fatalf("initial setup state: %d %s", got.Code, got.Body)
	}
	for i := 0; i < 2; i++ {
		if got := request(http.MethodPost, "/stripe-onboarding", "owner-token"); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), "connect.stripe.com/setup/test") {
			t.Fatalf("onboarding link: %d %s", got.Code, got.Body)
		}
	}
	if stripeRequests != 3 || mapping.FeeCents != 175 || mapping.RestaurantID != restaurantID {
		t.Fatalf("unexpected Stripe retry or fee snapshot: %d %#v", stripeRequests, mapping)
	}
	if got := request(http.MethodGet, "/payments", "owner-token"); got.Code != http.StatusOK || !strings.Contains(got.Body.String(), `"status":"ready"`) {
		t.Fatalf("completed setup state: %d %s", got.Code, got.Body)
	}
}
