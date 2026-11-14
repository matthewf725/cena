package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRefundWebhookCanLinkProviderRefundBeforeAPIResponse(t *testing.T) {
	const (
		orderID   = "550e8400-e29b-41d4-a716-446655440000"
		accountID = "acct_test123"
		sessionID = "cs_test123"
		refundID  = "re_test123"
		intentID  = "pi_test123"
	)
	expires := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	reservation := checkoutReservation{OrderID: orderID, AmountCents: 2599, SubtotalCents: 2900, DiscountCents: 301,
		PromoCode: ptrString("TEST25"), DiscountPercent: ptrInt(10), Currency: "usd", ApplicationFeeCents: 175,
		StripeAccountID: accountID, SessionID: sessionID, ExpiresAt: expires, Status: "pending"}
	for _, tc := range []struct {
		name, eventAccount, eventAttempt, storedRefundID, providerAttempt, providerOrder, sessionStatus string
		contextNull, providerUnavailable                                                                bool
		wantHTTP                                                                                        int
		wantGets, wantRecords                                                                           int
	}{
		{name: "webhook arrives before refund response is stored", eventAttempt: "1", providerAttempt: "1", providerOrder: orderID,
			sessionStatus: "complete", wantHTTP: http.StatusOK, wantGets: 3, wantRecords: 1},
		{name: "stale attempt is ignored", eventAttempt: "2", providerAttempt: "2", providerOrder: orderID,
			contextNull: true, wantHTTP: http.StatusOK},
		{name: "wrong connected account is ignored", eventAccount: "acct_other123", eventAttempt: "1", providerAttempt: "1", providerOrder: orderID,
			contextNull: true, wantHTTP: http.StatusOK},
		{name: "provider attempt mismatch is not linked", eventAttempt: "1", providerAttempt: "2", providerOrder: orderID,
			sessionStatus: "complete", wantHTTP: http.StatusServiceUnavailable, wantGets: 1},
		{name: "provider order mismatch is not linked", eventAttempt: "1", providerAttempt: "1", providerOrder: "650e8400-e29b-41d4-a716-446655440000",
			sessionStatus: "complete", wantHTTP: http.StatusServiceUnavailable, wantGets: 1},
		{name: "stored refund ID mismatch is not linked", eventAttempt: "1", storedRefundID: "re_other", providerAttempt: "1", providerOrder: orderID,
			sessionStatus: "complete", wantHTTP: http.StatusServiceUnavailable, wantGets: 1},
		{name: "unknown provider result stays retryable", eventAttempt: "1", providerAttempt: "1", providerOrder: orderID,
			providerUnavailable: true, sessionStatus: "complete", wantHTTP: http.StatusServiceUnavailable, wantGets: 1},
		{name: "unpaid checkout cannot be linked", eventAttempt: "1", providerAttempt: "1", providerOrder: orderID,
			sessionStatus: "open", wantHTTP: http.StatusServiceUnavailable, wantGets: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stripeGets, recordCalls := 0, 0
			expectedAttempt, _ := strconv.Atoi(tc.eventAttempt)
			eventAccount := tc.eventAccount
			if eventAccount == "" {
				eventAccount = accountID
			}
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "supabase.test" {
					switch r.URL.Path {
					case "/rest/v1/rpc/checkout_refund_event_context":
						var args map[string]any
						_ = json.NewDecoder(r.Body).Decode(&args)
						if args["p_order_id"] != orderID || args["p_attempt"] != float64(expectedAttempt) || args["p_account_id"] != eventAccount {
							t.Errorf("wrong refund attempt/account context lookup: %#v", args)
						}
						if tc.contextNull {
							return jsonResponse(http.StatusOK, `null`), nil
						}
						context := map[string]any{"order_id": orderID, "amount_cents": reservation.AmountCents, "subtotal_cents": reservation.SubtotalCents,
							"discount_cents": reservation.DiscountCents, "promo_code": *reservation.PromoCode, "discount_percent": *reservation.DiscountPercent,
							"currency": reservation.Currency, "application_fee_cents": reservation.ApplicationFeeCents,
							"stripe_account_id": accountID, "session_id": sessionID, "expires_at": expires, "refund_id": tc.storedRefundID}
						out, _ := json.Marshal(context)
						return jsonResponse(http.StatusOK, string(out)), nil
					case "/rest/v1/rpc/record_checkout_refund":
						recordCalls++
						var args map[string]any
						_ = json.NewDecoder(r.Body).Decode(&args)
						if args["p_order_id"] != orderID || args["p_attempt"] != float64(1) || args["p_refund_id"] != refundID || args["p_status"] != "succeeded" {
							t.Errorf("unverified refund link was recorded: %#v", args)
						}
						return jsonResponse(http.StatusOK, `"refunded"`), nil
					default:
						t.Errorf("unexpected Supabase request %s", r.URL.Path)
						return jsonResponse(http.StatusNotFound, `{}`), nil
					}
				}
				if r.URL.Host != "127.0.0.1:1234" {
					t.Errorf("unexpected upstream host %s", r.URL.Host)
					return jsonResponse(500, `{}`), nil
				}
				if r.Method != http.MethodGet || r.Header.Get("Stripe-Account") != accountID {
					t.Errorf("refund recovery must perform authenticated reads in the recorded account: %s %s account=%s", r.Method, r.URL.Path, r.Header.Get("Stripe-Account"))
				}
				stripeGets++
				switch r.URL.Path {
				case "/v1/refunds/" + refundID:
					if tc.providerUnavailable {
						return jsonResponse(http.StatusNotFound, `{"error":{"message":"not found"}}`), nil
					}
					providerRefund := stripeRefund{ID: refundID, Status: "succeeded", PaymentIntent: intentID, Currency: "usd", Amount: reservation.AmountCents,
						Metadata: map[string]string{"cena_order_id": tc.providerOrder, "cena_refund_attempt": tc.providerAttempt}}
					out, _ := json.Marshal(providerRefund)
					return jsonResponse(http.StatusOK, string(out)), nil
				case "/v1/checkout/sessions/" + sessionID:
					session := checkoutSession{ID: sessionID, Status: tc.sessionStatus, PaymentStatus: "paid", AmountTotal: reservation.AmountCents,
						Currency: "usd", ClientReferenceID: orderID, ExpiresAt: expires.Unix(), PaymentIntent: intentID,
						Metadata:           map[string]string{"order_id": orderID, "cena_order_id": orderID, "application_fee_cents": "175"},
						PaymentMethodTypes: []string{"card"}}
					out, _ := json.Marshal(session)
					return jsonResponse(http.StatusOK, string(out)), nil
				case "/v1/payment_intents/" + intentID:
					return jsonResponse(http.StatusOK, `{"id":"`+intentID+`","status":"succeeded","currency":"usd","amount":2599,"amount_received":2599,"application_fee_amount":175,"metadata":{"order_id":"`+orderID+`","cena_order_id":"`+orderID+`"},"latest_charge":{"created":`+jsonNumber(time.Now().Unix())+`}}`), nil
				default:
					t.Errorf("unexpected Stripe retrieval %s", r.URL.Path)
					return jsonResponse(http.StatusNotFound, `{}`), nil
				}
			})}
			api := New(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role",
				StripeSecretKey: "sk_test_fake", StripeWebhookSecret: "whsec_fixture", StripeAPIBaseURL: "http://127.0.0.1:1234",
				WebBaseURL: "https://cena.example", Client: client, StripeClient: client})
			payload := `{"id":"evt_refund_fixture","type":"refund.updated","created":1,"account":"` + eventAccount + `","data":{"object":{"id":"` + refundID + `","status":"succeeded","payment_intent":"` + intentID + `","currency":"usd","amount":2599,"metadata":{"cena_order_id":"` + orderID + `","cena_refund_attempt":"` + tc.eventAttempt + `"}}}}`
			r := httptest.NewRequest(http.MethodPost, "/v1/stripe/webhook", strings.NewReader(payload))
			r.Header.Set("Stripe-Signature", signedStripeHeader("whsec_fixture", []byte(payload), time.Now()))
			w := httptest.NewRecorder()
			api.ServeHTTP(w, r)
			if w.Code != tc.wantHTTP {
				t.Fatalf("webhook status=%d body=%s", w.Code, w.Body.String())
			}
			if stripeGets != tc.wantGets || recordCalls != tc.wantRecords {
				t.Fatalf("Stripe GETs=%d records=%d; expected %d/%d", stripeGets, recordCalls, tc.wantGets, tc.wantRecords)
			}
		})
	}
}

func TestRefundRouteRejectsProviderResponseForAnotherAttempt(t *testing.T) {
	const orderID = "550e8400-e29b-41d4-a716-446655440000"
	const userID = "650e8400-e29b-41d4-a716-446655440000"
	const accountID = "acct_test123"
	const sessionID = "cs_test123"
	const intentID = "pi_test123"
	expires := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	reservation := checkoutReservation{OrderID: orderID, AmountCents: 2599, SubtotalCents: 2900, DiscountCents: 301,
		PromoCode: ptrString("TEST25"), DiscountPercent: ptrInt(10), Currency: "usd", ApplicationFeeCents: 175,
		StripeAccountID: accountID, SessionID: sessionID, ExpiresAt: expires, Status: "pending"}
	stripePosts, recordCalls := 0, 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "supabase.test" {
			switch r.URL.Path {
			case "/auth/v1/user":
				return jsonResponse(http.StatusOK, `{"id":"`+userID+`"}`), nil
			case "/rest/v1/rpc/begin_checkout_refund":
				out, _ := json.Marshal(map[string]any{"status": "pending", "attempt": 1, "refund_id": nil,
					"order_id": orderID, "session_id": sessionID, "stripe_account_id": accountID,
					"amount_cents": reservation.AmountCents, "subtotal_cents": reservation.SubtotalCents,
					"discount_cents": reservation.DiscountCents, "promo_code": *reservation.PromoCode,
					"discount_percent": *reservation.DiscountPercent, "currency": "usd", "application_fee_cents": 175, "expires_at": expires})
				return jsonResponse(http.StatusOK, string(out)), nil
			case "/rest/v1/rpc/record_checkout_refund":
				recordCalls++
				return jsonResponse(http.StatusOK, `"refunded"`), nil
			default:
				t.Errorf("unexpected Supabase request %s", r.URL.Path)
				return jsonResponse(http.StatusNotFound, `{}`), nil
			}
		}
		if r.URL.Host != "127.0.0.1:1234" {
			t.Errorf("unexpected upstream host %s", r.URL.Host)
			return jsonResponse(500, `{}`), nil
		}
		if r.Header.Get("Stripe-Account") != accountID {
			t.Errorf("Stripe request used wrong connected account: %q", r.Header.Get("Stripe-Account"))
		}
		switch r.URL.Path {
		case "/v1/checkout/sessions/" + sessionID:
			session := checkoutSession{ID: sessionID, Status: "complete", PaymentStatus: "paid", AmountTotal: 2599, Currency: "usd",
				ClientReferenceID: orderID, ExpiresAt: expires.Unix(), PaymentIntent: intentID,
				Metadata:           map[string]string{"order_id": orderID, "cena_order_id": orderID, "application_fee_cents": "175"},
				PaymentMethodTypes: []string{"card"}}
			out, _ := json.Marshal(session)
			return jsonResponse(http.StatusOK, string(out)), nil
		case "/v1/payment_intents/" + intentID:
			return jsonResponse(http.StatusOK, `{"id":"`+intentID+`","status":"succeeded","currency":"usd","amount":2599,"amount_received":2599,"application_fee_amount":175,"metadata":{"order_id":"`+orderID+`","cena_order_id":"`+orderID+`"},"latest_charge":{"created":`+strconv.FormatInt(time.Now().Unix(), 10)+`}}`), nil
		case "/v1/refunds":
			stripePosts++
			r.ParseForm()
			if r.Method != http.MethodPost || r.Header.Get("Idempotency-Key") != "cena-refund-"+orderID+"-1" ||
				r.Form.Get("metadata[cena_refund_attempt]") != "1" {
				t.Errorf("refund request did not use the exact attempt/idempotency key: %v", r.Form)
			}
			return jsonResponse(http.StatusOK, `{"id":"re_test123","status":"succeeded","payment_intent":"`+intentID+`","currency":"usd","amount":2599,"metadata":{"cena_order_id":"`+orderID+`","cena_refund_attempt":"2"}}`), nil
		default:
			t.Errorf("unexpected Stripe request %s", r.URL.Path)
			return jsonResponse(http.StatusNotFound, `{}`), nil
		}
	})}
	api := New(Config{SupabaseURL: "https://supabase.test", SupabaseAnonKey: "anon", SupabaseServiceRoleKey: "service-role",
		StripeSecretKey: "sk_test_fake", StripeWebhookSecret: "whsec_fixture", StripeAPIBaseURL: "http://127.0.0.1:1234",
		WebBaseURL: "https://cena.example", Client: client, StripeClient: client})
	r := httptest.NewRequest(http.MethodPost, "/v1/orders/"+orderID+"/refund", nil)
	r.Header.Set("Authorization", "Bearer owner-token")
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway || stripePosts != 1 || recordCalls != 0 {
		t.Fatalf("wrong attempt response was accepted: status=%d stripePosts=%d recordCalls=%d body=%s", w.Code, stripePosts, recordCalls, w.Body.String())
	}
}

func jsonNumber(v int64) string { return strconv.FormatInt(v, 10) }
