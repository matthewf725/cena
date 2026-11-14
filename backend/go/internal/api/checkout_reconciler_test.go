package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestReconcileCheckoutClaimOnlyReleasesProviderConfirmedExpiry(t *testing.T) {
	for _, tc := range []struct {
		name, stripeStatus, paymentStatus, expectedRelease, expectedRetry string
		badAmount                                                         bool
	}{
		{name: "provider expired", stripeStatus: "expired", paymentStatus: "unpaid", expectedRelease: "expired", expectedRetry: "false"},
		{name: "still open", stripeStatus: "open", paymentStatus: "unpaid", expectedRetry: "true"},
		{name: "paid", stripeStatus: "complete", paymentStatus: "paid", expectedRetry: "false"},
		{name: "mismatched session", stripeStatus: "expired", paymentStatus: "unpaid", expectedRetry: "true", badAmount: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const orderID = "550e8400-e29b-41d4-a716-446655440000"
			const claimID = "750e8400-e29b-41d4-a716-446655440000"
			expires := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
			reservation := checkoutReservation{OrderID: orderID, AmountCents: 2400, SubtotalCents: 2600, DiscountCents: 200,
				Currency: "usd", ApplicationFeeCents: 175, StripeAccountID: "acct_test123", SessionID: "cs_test_123",
				ExpiresAt: expires, Status: "pending", PromoCode: ptrString("SAVE10"), DiscountPercent: ptrInt(8)}
			var released, finalized bool
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "api.stripe.com" {
					if r.Method != http.MethodGet {
						t.Errorf("worker must never create/expire Stripe sessions: %s %s", r.Method, r.URL.Path)
					}
					if r.Header.Get("Stripe-Account") != reservation.StripeAccountID {
						t.Errorf("Stripe account header mismatch: %q", r.Header.Get("Stripe-Account"))
					}
					switch {
					case r.URL.Path == "/v1/checkout/sessions/cs_test_123":
						session := checkoutSession{ID: reservation.SessionID, Status: tc.stripeStatus, PaymentStatus: tc.paymentStatus,
							AmountTotal: reservation.AmountCents, Currency: "usd", ClientReferenceID: orderID, ExpiresAt: expires.Unix(),
							PaymentIntent:      "pi_test123",
							Metadata:           map[string]string{"order_id": orderID, "cena_order_id": orderID, "application_fee_cents": "175"},
							PaymentMethodTypes: []string{"card"}}
						if tc.badAmount {
							session.AmountTotal++
						}
						out, _ := json.Marshal(session)
						return jsonResponse(http.StatusOK, string(out)), nil
					case r.URL.Path == "/v1/payment_intents/pi_test123":
						return jsonResponse(http.StatusOK, `{"id":"pi_test123","status":"succeeded","currency":"usd","amount":2400,"amount_received":2400,"application_fee_amount":175,"metadata":{"order_id":"`+orderID+`","cena_order_id":"`+orderID+`"},"latest_charge":{"created":`+strconv.FormatInt(time.Now().Unix(), 10)+`}}`), nil
					default:
						t.Errorf("unexpected Stripe request %s", r.URL)
						return jsonResponse(http.StatusNotFound, `{}`), nil
					}
				}
				if r.URL.Host != "supabase.test" {
					t.Errorf("unexpected host %s", r.URL.Host)
					return jsonResponse(500, `{}`), nil
				}
				switch r.URL.Path {
				case "/rest/v1/rpc/release_expired_checkout":
					released = true
					var args map[string]string
					_ = json.NewDecoder(r.Body).Decode(&args)
					if args["p_order_id"] != orderID || args["p_expected_session_id"] != reservation.SessionID || args["p_expected_account_id"] != reservation.StripeAccountID || args["p_result"] != "expired" {
						t.Errorf("release did not require exact recorded session/account: %#v", args)
					}
					return jsonResponse(http.StatusOK, `"expired"`), nil
				case "/rest/v1/rpc/finalize_checkout_event":
					finalized = true
					var args map[string]any
					_ = json.NewDecoder(r.Body).Decode(&args)
					if args["p_event_id"] != "reconcile_"+reservation.SessionID || args["p_order_id"] != orderID {
						t.Errorf("unexpected deterministic paid reconciliation event: %#v", args)
					}
					return jsonResponse(http.StatusOK, `"paid"`), nil
				case "/rest/v1/rpc/finish_checkout_reconciliation":
					var args map[string]any
					_ = json.NewDecoder(r.Body).Decode(&args)
					if args["p_order_id"] != orderID || args["p_claim_id"] != claimID || args["p_retry"] != (tc.expectedRetry == "true") {
						t.Errorf("unexpected claim completion: %#v", args)
					}
					return jsonResponse(http.StatusOK, `true`), nil
				default:
					t.Errorf("unexpected Supabase request %s", r.URL.Path)
					return jsonResponse(http.StatusNotFound, `{}`), nil
				}
			})}
			s := NewServer(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role",
				StripeSecretKey: "sk_test_fake", Client: client, StripeClient: client})
			claim := checkoutReconcileClaim{ClaimID: claimID, checkoutReservation: reservation}
			if err := s.reconcileClaim(context.Background(), claim); err != nil {
				t.Fatal(err)
			}
			if released != (tc.expectedRelease != "") {
				t.Errorf("released=%v expected release=%q", released, tc.expectedRelease)
			}
			if finalized != (tc.stripeStatus == "complete" && tc.paymentStatus == "paid" && !tc.badAmount) {
				t.Errorf("finalized=%v", finalized)
			}
		})
	}
}

func ptrString(v string) *string { return &v }
func ptrInt(v int) *int          { return &v }

func TestCheckoutReconcilerStillProcessesRecordedSessionsWhenUnrecordedReaperFails(t *testing.T) {
	const orderID = "550e8400-e29b-41d4-a716-446655440000"
	const claimID = "750e8400-e29b-41d4-a716-446655440000"
	const accountID = "acct_test123"
	const sessionID = "cs_test123"
	expires := time.Now().Add(-time.Minute).UTC().Truncate(time.Second)
	reservation := checkoutReservation{OrderID: orderID, AmountCents: 1000, SubtotalCents: 1000, Currency: "usd",
		ApplicationFeeCents: 175, StripeAccountID: accountID, SessionID: sessionID, ExpiresAt: expires, Status: "pending"}
	claimData, _ := json.Marshal([]checkoutReconcileClaim{{ClaimID: claimID, checkoutReservation: reservation}})
	var claimed, providerRead, released, finished bool
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "supabase.test" {
			switch r.URL.Path {
			case "/rest/v1/rpc/reap_expired_unrecorded_checkout_reservations":
				return jsonResponse(http.StatusInternalServerError, `{}`), nil
			case "/rest/v1/rpc/claim_due_checkout_reconciliations":
				claimed = true
				return jsonResponse(http.StatusOK, string(claimData)), nil
			case "/rest/v1/rpc/release_expired_checkout":
				released = true
				return jsonResponse(http.StatusOK, `"expired"`), nil
			case "/rest/v1/rpc/finish_checkout_reconciliation":
				finished = true
				return jsonResponse(http.StatusOK, `true`), nil
			default:
				t.Errorf("unexpected Supabase request %s", r.URL.Path)
				return jsonResponse(http.StatusNotFound, `{}`), nil
			}
		}
		if r.URL.Host != "api.stripe.com" {
			t.Errorf("unexpected host %s", r.URL.Host)
			return jsonResponse(http.StatusInternalServerError, `{}`), nil
		}
		if r.Method != http.MethodGet || r.Header.Get("Stripe-Account") != accountID {
			t.Errorf("recorded session must only be retrieved in its account")
		}
		providerRead = true
		session := checkoutSession{ID: sessionID, Status: "expired", PaymentStatus: "unpaid", AmountTotal: 1000,
			Currency: "usd", ClientReferenceID: orderID, ExpiresAt: expires.Unix(),
			Metadata:           map[string]string{"order_id": orderID, "cena_order_id": orderID, "application_fee_cents": "175"},
			PaymentMethodTypes: []string{"card"}}
		out, _ := json.Marshal(session)
		return jsonResponse(http.StatusOK, string(out)), nil
	})}
	s := NewServer(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role",
		StripeSecretKey: "sk_test_fake", Client: client, StripeClient: client})
	if err := s.reconcileDueCheckoutSessions(context.Background()); err == nil {
		t.Fatal("expected the failed unrecorded reaper RPC to remain visible to the caller")
	}
	if !claimed || !providerRead || !released || !finished {
		t.Fatalf("reaper failure blocked recorded-session work: claimed=%v providerRead=%v released=%v finished=%v", claimed, providerRead, released, finished)
	}
}
