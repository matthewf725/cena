package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestStripeRequestUsesConnectedAccountAndIdempotency(t *testing.T) {
	called := false
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		called = true
		if r.Method != http.MethodPost || r.URL.String() != "https://stripe.test/v1/checkout/sessions" {
			t.Errorf("request %s %s", r.Method, r.URL)
		}
		if r.Header.Get("Authorization") != "Bearer sk_test_fake" {
			t.Errorf("authorization %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("Stripe-Account") != "acct_123abc" {
			t.Errorf("Stripe-Account %q", r.Header.Get("Stripe-Account"))
		}
		if r.Header.Get("Idempotency-Key") != "cena-order-1" {
			t.Errorf("Idempotency-Key %q", r.Header.Get("Idempotency-Key"))
		}
		b, _ := io.ReadAll(r.Body)
		form, _ := url.ParseQuery(string(b))
		if form.Get("payment_intent_data[application_fee_amount]") != "175" || form.Get("line_items[0][price_data][unit_amount]") != "2599" {
			t.Errorf("Stripe params %s", b)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"id":"cs_test_1"}`))}, nil
	})}
	s := &Server{cfg: Config{StripeSecretKey: "sk_test_fake", StripeAPIBaseURL: "https://stripe.test"}, stripeClient: client}
	params := url.Values{"payment_intent_data[application_fee_amount]": {"175"}, "line_items[0][price_data][unit_amount]": {"2599"}}
	body, status, err := s.stripeRequest(context.Background(), http.MethodPost, "/v1/checkout/sessions", params, "acct_123abc", "cena-order-1")
	if err != nil || status != 200 || !strings.Contains(string(body), "cs_test_1") || !called {
		t.Fatalf("body=%s status=%d called=%v err=%v", body, status, called, err)
	}
}

func TestStripeRequestRejectsInvalidAccount(t *testing.T) {
	s := &Server{cfg: Config{StripeSecretKey: "sk_test_fake", StripeAPIBaseURL: "https://stripe.test"}, stripeClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { t.Fatal("unexpected Stripe call"); return nil, nil })}}
	_, status, err := s.stripeRequest(context.Background(), http.MethodPost, "/v1/checkout/sessions", url.Values{}, "not-an-account", "")
	if err == nil || status != http.StatusBadRequest {
		t.Fatalf("status=%d err=%v", status, err)
	}
}

func signedStripeHeader(secret string, body []byte, at time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", at.Unix())
	_, _ = mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%x", at.Unix(), mac.Sum(nil))
}

func TestVerifyStripeSignatureAndTimestampTolerance(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"type":"checkout.session.completed"}`)
	header := signedStripeHeader("whsec_test", body, now)
	if !verifyStripeSignature(header, body, "whsec_test", now) {
		t.Fatal("expected valid signature")
	}
	if verifyStripeSignature(header, []byte(`{"type":"tampered"}`), "whsec_test", now) {
		t.Fatal("accepted tampered payload")
	}
	if verifyStripeSignature(signedStripeHeader("whsec_test", body, now.Add(-6*time.Minute)), body, "whsec_test", now) {
		t.Fatal("accepted stale signature")
	}
	if verifyStripeSignature(header, body, "", now) {
		t.Fatal("accepted empty secret")
	}
}
