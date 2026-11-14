package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const sandboxProjectConfirmation = "NONPRODUCTION_SANDBOX_ONLY"

type sandboxCheckoutSettings struct {
	SupabaseURL, SupabaseAnonKey, SupabaseServiceRoleKey string
	StripeSecretKey, StripeWebhookSecret, WebBaseURL     string
	UserJWT, RestaurantID, SlotID, ItemID                string
	PromoCode, StripeAccountID, ProjectRef               string
}

func sandboxStripeGuard(secret, apiBaseURL, confirmation string) error {
	if confirmation != sandboxProjectConfirmation {
		return fmt.Errorf("set CENA_STRIPE_SANDBOX_CONFIRMATION=%s only after verifying the configured Supabase project is non-production", sandboxProjectConfirmation)
	}
	if !strings.HasPrefix(secret, "sk_test_") {
		return fmt.Errorf("sandbox verification refuses any Stripe key that is not sk_test_")
	}
	if apiBaseURL != "" && apiBaseURL != "https://api.stripe.com" {
		return fmt.Errorf("sandbox verification requires the canonical Stripe API URL")
	}
	return nil
}

func TestSandboxStripeGuard(t *testing.T) {
	if err := sandboxStripeGuard("sk_live_do_not_use", "", sandboxProjectConfirmation); err == nil {
		t.Fatal("live Stripe key should be rejected")
	}
	if err := sandboxStripeGuard("sk_test_x", "http://localhost:1234", sandboxProjectConfirmation); err == nil {
		t.Fatal("local fake Stripe URL should be rejected by the real sandbox verifier")
	}
	if err := sandboxStripeGuard("sk_test_x", "", ""); err == nil {
		t.Fatal("missing non-production project confirmation should be rejected")
	}
	if err := sandboxStripeGuard("sk_test_x", "https://api.stripe.com", sandboxProjectConfirmation); err != nil {
		t.Fatalf("valid sandbox configuration rejected: %v", err)
	}
}

// This test creates one unpaid Stripe test Checkout Session, verifies the
// connected-account fee and reduced quote, and expires it. It never opens the
// hosted Checkout URL or supplies a payment method.
func TestStripeSandboxCheckoutExpiryIntegration(t *testing.T) {
	if os.Getenv("CENA_STRIPE_SANDBOX_INTEGRATION") != "1" {
		t.Skip("set CENA_STRIPE_SANDBOX_INTEGRATION=1 to run the real Stripe sandbox check")
	}
	settings, err := loadSandboxCheckoutSettings(os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	apiBase := strings.TrimSpace(os.Getenv("STRIPE_API_BASE_URL"))
	if err := sandboxStripeGuard(settings.StripeSecretKey, apiBase, os.Getenv("CENA_STRIPE_SANDBOX_CONFIRMATION")); err != nil {
		t.Fatal(err)
	}
	if !checkoutOrderIDPattern.MatchString(settings.RestaurantID) || !checkoutOrderIDPattern.MatchString(settings.SlotID) ||
		!checkoutOrderIDPattern.MatchString(settings.ItemID) || !connectedAccountID.MatchString(settings.StripeAccountID) {
		t.Fatal("sandbox restaurant, slot, item, and connected-account IDs must be valid")
	}
	code, ok := normalizePromoCode(settings.PromoCode)
	if !ok || code == "" {
		t.Fatal("CENA_TEST_PROMO_CODE must name an active sandbox promotion")
	}
	webBase, err := url.Parse(settings.WebBaseURL)
	if err != nil || webBase.Scheme != "https" || webBase.Host == "" || webBase.User != nil {
		t.Fatal("CENA_WEB_BASE_URL must be a trusted HTTPS site")
	}

	cfg := Config{
		SupabaseURL: settings.SupabaseURL, SupabaseAnonKey: settings.SupabaseAnonKey,
		SupabaseServiceRoleKey: settings.SupabaseServiceRoleKey, StripeSecretKey: settings.StripeSecretKey,
		StripeWebhookSecret: settings.StripeWebhookSecret, WebBaseURL: settings.WebBaseURL,
		StripeAPIBaseURL: "https://api.stripe.com",
	}
	if _, err := url.ParseRequestURI(cfg.SupabaseURL); err != nil || cfg.SupabaseURL == "" || cfg.SupabaseAnonKey == "" || cfg.SupabaseServiceRoleKey == "" ||
		cfg.StripeWebhookSecret == "" || settings.UserJWT == "" {
		t.Fatal("sandbox verification requires Supabase URL/keys, webhook secret, and a buyer JWT")
	}
	// New validates the same configuration the deployed handler uses. All safety
	// gates above run before this point and before any network request.
	handler := New(cfg)
	supabaseClient := &http.Client{Timeout: 8 * time.Second}
	stripeClient := &http.Client{Timeout: 10 * time.Second}
	probe := &Server{cfg: cfg, client: supabaseClient, stripeClient: stripeClient}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	userReq := httptest.NewRequest(http.MethodGet, "/auth/v1/user", nil).WithContext(ctx)
	userReq.Header.Set("Authorization", "Bearer "+settings.UserJWT)
	userRec := httptest.NewRecorder()
	userID, verified := probe.authenticatedSupabaseUser(userRec, userReq)
	if !verified {
		t.Fatal("Supabase did not verify the sandbox buyer JWT")
	}
	if err := verifySandboxRestaurantMapping(ctx, probe, settings.RestaurantID, settings.StripeAccountID); err != nil {
		t.Fatal(err)
	}
	accountBody, _, err := probe.stripeRequest(ctx, http.MethodGet, "/v1/accounts/"+url.PathEscape(settings.StripeAccountID), nil, "", "")
	if err != nil {
		t.Fatal("could not verify the sandbox connected account with Stripe")
	}
	var account connectAccount
	if json.Unmarshal(accountBody, &account) != nil || account.ID != settings.StripeAccountID || !account.ChargesEnabled || !account.PayoutsEnabled {
		t.Fatal("sandbox connected account is not ready for test Checkout")
	}

	key, err := randomSandboxIdempotencyKey()
	if err != nil {
		t.Fatal("could not generate an idempotency key")
	}
	quoteBody, _ := json.Marshal(map[string]any{
		"p_restaurant_id": settings.RestaurantID, "p_slot_id": settings.SlotID,
		"p_items": []map[string]any{{"item_id": settings.ItemID, "quantity": 1}}, "promo_code": code,
	})
	quoteStatus, quoteRaw := sandboxAPIRequest(ctx, handler, http.MethodPost, "/v1/checkout/quote", settings.UserJWT, quoteBody)
	if quoteStatus != http.StatusOK {
		t.Fatalf("sandbox quote failed with HTTP %d", quoteStatus)
	}
	var quote checkoutQuote
	if json.Unmarshal(quoteRaw, &quote) != nil || !validQuote(quote, settings.RestaurantID, settings.SlotID) || quote.DiscountCents <= 0 || quote.PromoCode == nil || *quote.PromoCode != code {
		t.Fatal("sandbox quote did not return a valid reduced promotion total")
	}
	checkoutBody, _ := json.Marshal(map[string]any{
		"p_restaurant_id": settings.RestaurantID, "p_slot_id": settings.SlotID,
		"p_idempotency_key": key, "p_pickup_mode": "counter",
		"p_items":    []map[string]any{{"item_id": settings.ItemID, "quantity": 1}},
		"promo_code": code, "expected_amount_cents": quote.AmountCents,
	})
	orderID := ""
	defer func() {
		if orderID == "" {
			orderID = sandboxFindOrderID(ctx, probe, userID, key, settings.UserJWT)
		}
		if orderID == "" {
			return
		}
		// Retry creation idempotently before cancellation so a provider response
		// lost between Stripe and Supabase can still be recovered and expired.
		if status, _ := sandboxAPIRequest(ctx, handler, http.MethodPost, "/v1/checkout", settings.UserJWT, checkoutBody); status == http.StatusOK {
			// The body contains a Checkout URL; it is intentionally never logged.
		}
		cancelStatus, cancelBody := sandboxAPIRequest(ctx, handler, http.MethodDelete, "/v1/checkout/"+orderID, settings.UserJWT, nil)
		if cancelStatus != http.StatusOK {
			t.Errorf("sandbox session cleanup returned HTTP %d; an unrecorded ambiguous reservation will expire through the database safety timeout", cancelStatus)
			return
		}
		var result struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(cancelBody, &result) != nil || result.Status != "expired" {
			t.Errorf("sandbox cleanup did not confirm expiry")
			return
		}
		status, body := sandboxAPIRequest(ctx, handler, http.MethodGet, "/v1/checkout/"+orderID, settings.UserJWT, nil)
		if status != http.StatusOK {
			t.Errorf("sandbox status after expiry returned HTTP %d", status)
			return
		}
		var final struct {
			Status string `json:"status"`
		}
		if json.Unmarshal(body, &final) != nil || final.Status != "expired" {
			t.Errorf("sandbox order did not reach expired state")
		}
	}()

	status, response := sandboxAPIRequest(ctx, handler, http.MethodPost, "/v1/checkout", settings.UserJWT, checkoutBody)
	if status != http.StatusOK {
		// Do not print response bodies; provider responses can include session data.
		t.Fatalf("sandbox Checkout creation returned HTTP %d", status)
	}
	var created struct {
		OrderID         string  `json:"order_id"`
		CheckoutURL     string  `json:"checkout_url"`
		SubtotalCents   int     `json:"subtotal_cents"`
		DiscountCents   int     `json:"discount_cents"`
		AmountCents     int     `json:"amount_cents"`
		PromoCode       *string `json:"promo_code"`
		DiscountPercent *int    `json:"discount_percent"`
	}
	if json.Unmarshal(response, &created) != nil || !checkoutOrderIDPattern.MatchString(created.OrderID) || !validCheckoutURL(created.CheckoutURL) ||
		created.SubtotalCents != quote.SubtotalCents || created.DiscountCents != quote.DiscountCents || created.AmountCents != quote.AmountCents ||
		created.PromoCode == nil || *created.PromoCode != code || created.DiscountPercent == nil {
		t.Fatal("sandbox Checkout response did not match its reduced quote")
	}
	orderID = created.OrderID

	reservationBody, _, err := probe.serviceRPC(ctx, "get_checkout_for_owner", map[string]string{"p_order_id": orderID, "p_user_id": userID})
	if err != nil {
		t.Fatal("could not inspect the sandbox checkout reservation")
	}
	var reservation checkoutReservation
	if json.Unmarshal(reservationBody, &reservation) != nil || !validReservation(reservation) || reservation.StripeAccountID != settings.StripeAccountID || reservation.ApplicationFeeCents != 175 {
		t.Fatal("sandbox reservation did not use the expected connected account and $1.75 fee")
	}
	session, err := probe.retrieveCheckoutSession(ctx, reservation.SessionID, reservation.StripeAccountID)
	if err != nil || session.Status != "open" || session.PaymentStatus == "paid" || !validSessionForReservation(session, reservation) {
		t.Fatal("Stripe did not return a matching unpaid sandbox Checkout Session")
	}
	if !stripePaymentIntentPattern.MatchString(session.PaymentIntent) {
		t.Fatal("Stripe did not expose the PaymentIntent needed to inspect the application fee")
	}
	intentBody, _, err := probe.stripeRequest(ctx, http.MethodGet, "/v1/payment_intents/"+url.PathEscape(session.PaymentIntent), url.Values{"expand[]": {"latest_charge"}}, reservation.StripeAccountID, "")
	if err != nil {
		t.Fatal("could not inspect the sandbox PaymentIntent")
	}
	var intent stripePaymentIntent
	if json.Unmarshal(intentBody, &intent) != nil || intent.ID != session.PaymentIntent || intent.Amount != quote.AmountCents ||
		intent.ApplicationFeeAmount != 175 || strings.ToLower(intent.Currency) != "usd" ||
		intent.Status == "succeeded" || intent.AmountReceived != 0 || intent.LatestCharge.Created != 0 {
		t.Fatal("sandbox PaymentIntent fee/amount/state was not the expected unpaid $1.75 test setup")
	}
}

func loadSandboxCheckoutSettings(getenv func(string) string) (sandboxCheckoutSettings, error) {
	var s sandboxCheckoutSettings
	fields := []struct {
		key string
		out *string
	}{
		{"SUPABASE_URL", &s.SupabaseURL}, {"SUPABASE_ANON_KEY", &s.SupabaseAnonKey},
		{"SUPABASE_SERVICE_ROLE_KEY", &s.SupabaseServiceRoleKey}, {"STRIPE_SECRET_KEY", &s.StripeSecretKey},
		{"STRIPE_WEBHOOK_SECRET", &s.StripeWebhookSecret}, {"CENA_WEB_BASE_URL", &s.WebBaseURL},
		{"CENA_TEST_USER_JWT", &s.UserJWT}, {"CENA_TEST_RESTAURANT_ID", &s.RestaurantID},
		{"CENA_TEST_SLOT_ID", &s.SlotID}, {"CENA_TEST_ITEM_ID", &s.ItemID},
		{"CENA_TEST_PROMO_CODE", &s.PromoCode}, {"CENA_TEST_STRIPE_ACCOUNT_ID", &s.StripeAccountID},
		{"CENA_STRIPE_SANDBOX_PROJECT_REF", &s.ProjectRef},
	}
	for _, field := range fields {
		*field.out = strings.TrimSpace(getenv(field.key))
		if *field.out == "" {
			return s, fmt.Errorf("missing required sandbox environment variable %s", field.key)
		}
	}
	if !strings.EqualFold(strings.TrimSpace(getenv("CENA_STRIPE_SANDBOX_CONFIRMATION")), sandboxProjectConfirmation) {
		return s, fmt.Errorf("set CENA_STRIPE_SANDBOX_CONFIRMATION=%s only after verifying this project is non-production", sandboxProjectConfirmation)
	}
	if err := verifySupabaseSandboxProject(s.SupabaseURL, s.ProjectRef); err != nil {
		return s, err
	}
	return s, nil
}

func verifySupabaseSandboxProject(rawURL, expectedRef string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("SUPABASE_URL is invalid for sandbox verification")
	}
	host := strings.ToLower(parsed.Hostname())
	ref := ""
	if strings.HasSuffix(host, ".supabase.co") {
		if parsed.Scheme != "https" {
			return fmt.Errorf("hosted sandbox SUPABASE_URL must use HTTPS")
		}
		ref = strings.TrimSuffix(host, ".supabase.co")
	} else if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return fmt.Errorf("local sandbox SUPABASE_URL must use HTTP or HTTPS")
		}
		ref = "local"
	}
	if ref == "" || !strings.EqualFold(ref, expectedRef) {
		return fmt.Errorf("CENA_STRIPE_SANDBOX_PROJECT_REF must exactly match the configured non-production Supabase project")
	}
	return nil
}

func verifySandboxRestaurantMapping(ctx context.Context, s *Server, restaurantID, expectedAccountID string) error {
	path := "/rest/v1/restaurant_payment_accounts?select=restaurant_id,stripe_account_id,application_fee_cents,charges_enabled,payouts_enabled&restaurant_id=eq." + url.QueryEscape(restaurantID) + "&limit=1"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.SupabaseURL+path, nil)
	if err != nil {
		return fmt.Errorf("could not prepare sandbox account mapping check")
	}
	key := strings.TrimSpace(s.cfg.SupabaseServiceRoleKey)
	req.Header.Set("apikey", key)
	if !strings.HasPrefix(key, "sb_secret_") {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("could not verify sandbox restaurant payment mapping")
	}
	defer resp.Body.Close()
	var mappings []struct {
		RestaurantID        string `json:"restaurant_id"`
		StripeAccountID     string `json:"stripe_account_id"`
		ApplicationFeeCents int    `json:"application_fee_cents"`
		ChargesEnabled      bool   `json:"charges_enabled"`
		PayoutsEnabled      bool   `json:"payouts_enabled"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&mappings) != nil || len(mappings) != 1 ||
		mappings[0].RestaurantID != restaurantID || mappings[0].StripeAccountID != expectedAccountID || mappings[0].ApplicationFeeCents != 175 ||
		!mappings[0].ChargesEnabled || !mappings[0].PayoutsEnabled {
		return fmt.Errorf("sandbox restaurant must map to the configured ready connected account with a 175-cent fee")
	}
	return nil
}

func randomSandboxIdempotencyKey() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return "sandbox-" + hex.EncodeToString(bytes[:]), nil
}

func sandboxAPIRequest(ctx context.Context, handler http.Handler, method, path, token string, body []byte) (int, []byte) {
	r := httptest.NewRequest(method, path, strings.NewReader(string(body))).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func sandboxFindOrderID(ctx context.Context, s *Server, userID, idempotencyKey, userJWT string) string {
	path := "/rest/v1/orders?select=id&user_id=eq." + url.QueryEscape(userID) + "&idempotency_key=eq." + url.QueryEscape(idempotencyKey) + "&limit=1"
	r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+userJWT)
	body, status, err := s.supabase(r, http.MethodGet, path, nil)
	if err != nil || status != http.StatusOK {
		return ""
	}
	var rows []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(body, &rows) != nil || len(rows) != 1 || !checkoutOrderIDPattern.MatchString(rows[0].ID) {
		return ""
	}
	return rows[0].ID
}
