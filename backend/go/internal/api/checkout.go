package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const webhookBodyLimit = 1 << 20

var checkoutOrderIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type checkoutReservation struct {
	OrderID             string    `json:"order_id"`
	AmountCents         int       `json:"amount_cents"`
	SubtotalCents       int       `json:"subtotal_cents"`
	DiscountCents       int       `json:"discount_cents"`
	PromoCode           *string   `json:"promo_code"`
	DiscountPercent     *int      `json:"discount_percent"`
	Currency            string    `json:"currency"`
	ApplicationFeeCents int       `json:"application_fee_cents"`
	StripeAccountID     string    `json:"stripe_account_id"`
	SessionID           string    `json:"session_id"`
	CheckoutURL         string    `json:"checkout_url"`
	ExpiresAt           time.Time `json:"expires_at"`
	Status              string    `json:"status"`
	PaymentStatus       string    `json:"payment_status"`
}

type checkoutQuote struct {
	RestaurantID    string  `json:"restaurant_id"`
	SlotID          string  `json:"slot_id"`
	SubtotalCents   int     `json:"subtotal_cents"`
	DiscountCents   int     `json:"discount_cents"`
	AmountCents     int     `json:"amount_cents"`
	Currency        string  `json:"currency"`
	PromoCode       *string `json:"promo_code"`
	DiscountPercent *int    `json:"discount_percent"`
}

type promoRequest struct {
	RestaurantID string          `json:"p_restaurant_id"`
	SlotID       string          `json:"p_slot_id"`
	Items        json.RawMessage `json:"p_items"`
	PromoCode    string          `json:"promo_code"`
}

var promoCodePattern = regexp.MustCompile(`^[A-Z0-9][A-Z0-9_-]{2,31}$`)

func normalizePromoCode(code string) (string, bool) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return "", true
	}
	return code, promoCodePattern.MatchString(code)
}

func validQuote(v checkoutQuote, restaurantID, slotID string) bool {
	if v.RestaurantID != restaurantID || v.SlotID != slotID || v.SubtotalCents < 0 || v.DiscountCents < 0 ||
		v.AmountCents < 0 || v.AmountCents != v.SubtotalCents-v.DiscountCents || !strings.EqualFold(v.Currency, "usd") {
		return false
	}
	if v.PromoCode == nil {
		return v.DiscountCents == 0 && v.DiscountPercent == nil
	}
	return promoCodePattern.MatchString(*v.PromoCode) && v.DiscountCents > 0 && v.DiscountPercent != nil && *v.DiscountPercent >= 1 && *v.DiscountPercent <= 90
}

func validPromotionSnapshot(v checkoutReservation) bool {
	if v.SubtotalCents != v.AmountCents+v.DiscountCents || v.DiscountCents < 0 {
		return false
	}
	if v.PromoCode == nil {
		return v.DiscountCents == 0 && v.DiscountPercent == nil
	}
	return promoCodePattern.MatchString(*v.PromoCode) && v.DiscountCents > 0 && v.DiscountPercent != nil && *v.DiscountPercent >= 1 && *v.DiscountPercent <= 90
}

func (s *Server) quoteCheckout(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedSupabaseUser(w, r)
	if !ok {
		return
	}
	if !s.paymentConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "online checkout is not configured"})
		return
	}
	var in promoRequest
	if !decodeBody(w, r, &in) {
		return
	}
	code, valid := normalizePromoCode(in.PromoCode)
	if !valid || !checkoutOrderIDPattern.MatchString(in.RestaurantID) || !checkoutOrderIDPattern.MatchString(in.SlotID) || !validOrderItems(in.Items) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid checkout quote request"})
		return
	}
	var promo any
	if code != "" {
		promo = code
	}
	data, status, err := s.serviceRPC(r.Context(), "quote_checkout_order", map[string]any{
		"p_user_id": userID, "p_restaurant_id": in.RestaurantID, "p_slot_id": in.SlotID, "p_items": in.Items, "p_promo_code": promo,
	})
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	var quote checkoutQuote
	if err := json.Unmarshal(data, &quote); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "checkout quote response was invalid"})
		return
	}
	// The service RPC is scoped by these request IDs and returns price fields only.
	// Echo the already-validated IDs rather than requiring the SQL function to repeat them.
	quote.RestaurantID, quote.SlotID = in.RestaurantID, in.SlotID
	if !validQuote(quote, in.RestaurantID, in.SlotID) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "checkout quote response was invalid"})
		return
	}
	writeJSON(w, http.StatusOK, quote)
}

func validOrderItems(raw json.RawMessage) bool {
	var items []struct {
		ItemID   string `json:"item_id"`
		Quantity int    `json:"quantity"`
	}
	if len(raw) == 0 || len(raw) > 32<<10 || json.Unmarshal(raw, &items) != nil || len(items) == 0 || len(items) > 30 {
		return false
	}
	for _, item := range items {
		if !checkoutOrderIDPattern.MatchString(item.ItemID) || item.Quantity < 1 || item.Quantity > 100 {
			return false
		}
	}
	return true
}

func (v checkoutReservation) state() string {
	if v.Status != "" {
		return v.Status
	}
	return v.PaymentStatus
}

type checkoutSession struct {
	ID                 string            `json:"id"`
	URL                string            `json:"url"`
	Status             string            `json:"status"`
	PaymentStatus      string            `json:"payment_status"`
	AmountTotal        int               `json:"amount_total"`
	Currency           string            `json:"currency"`
	ClientReferenceID  string            `json:"client_reference_id"`
	ExpiresAt          int64             `json:"expires_at"`
	Created            int64             `json:"created"`
	PaymentIntent      string            `json:"payment_intent"`
	Metadata           map[string]string `json:"metadata"`
	PaymentMethodTypes []string          `json:"payment_method_types"`
}

type stripePaymentIntent struct {
	ID                   string            `json:"id"`
	Status               string            `json:"status"`
	Currency             string            `json:"currency"`
	Amount               int               `json:"amount"`
	AmountReceived       int               `json:"amount_received"`
	ApplicationFeeAmount int               `json:"application_fee_amount"`
	Created              int64             `json:"created"`
	Metadata             map[string]string `json:"metadata"`
	LatestCharge         struct {
		Created int64 `json:"created"`
	} `json:"latest_charge"`
}

func (s *Server) paymentConfigured() bool {
	return s.cfg.StripeSecretKey != "" && s.cfg.StripeWebhookSecret != "" && s.cfg.SupabaseServiceRoleKey != "" && s.cfg.WebBaseURL != ""
}

func (s *Server) authenticatedSupabaseUser(w http.ResponseWriter, r *http.Request) (string, bool) {
	if _, ok := bearerToken(r); !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication required"})
		return "", false
	}
	body, status, err := s.supabase(r, http.MethodGet, "/auth/v1/user", nil)
	if err != nil {
		upstreamError(w, status, err)
		return "", false
	}
	var user struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &user); err != nil || !checkoutOrderIDPattern.MatchString(user.ID) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "could not verify the signed-in user"})
		return "", false
	}
	return user.ID, true
}

func (s *Server) startCheckout(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedSupabaseUser(w, r)
	if !ok {
		return
	}
	if !s.paymentConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "online checkout is not configured"})
		return
	}
	var in orderRequest
	if !decodeBody(w, r, &in) {
		return
	}
	code, promoValid := normalizePromoCode(in.PromoCode)
	if !promoValid || in.ExpectedAmountCents == nil || *in.ExpectedAmountCents < 0 || !checkoutOrderIDPattern.MatchString(in.RestaurantID) || !checkoutOrderIDPattern.MatchString(in.SlotID) || len(in.IdempotencyKey) < 8 || len(in.IdempotencyKey) > 128 || in.PickupMode == "" || !validOrderItems(in.Items) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid checkout request"})
		return
	}
	if len(in.Vehicle) == 0 {
		in.Vehicle = json.RawMessage(`{}`)
	}
	if !json.Valid(in.Vehicle) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid vehicle"})
		return
	}
	args := map[string]json.RawMessage{}
	args["p_restaurant_id"], _ = json.Marshal(in.RestaurantID)
	args["p_slot_id"], _ = json.Marshal(in.SlotID)
	args["p_idempotency_key"], _ = json.Marshal(in.IdempotencyKey)
	args["p_pickup_mode"], _ = json.Marshal(in.PickupMode)
	args["p_vehicle"] = in.Vehicle
	args["p_items"] = in.Items
	args["p_user_id"], _ = json.Marshal(userID)
	args["p_expected_amount_cents"], _ = json.Marshal(*in.ExpectedAmountCents)
	if code == "" {
		args["p_promo_code"] = json.RawMessage("null")
	} else {
		args["p_promo_code"], _ = json.Marshal(code)
	}
	reservationBody, err := json.Marshal(args)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid checkout request"})
		return
	}
	rpcData, status, err := s.serviceRPC(r.Context(), "reserve_checkout_order", json.RawMessage(reservationBody))
	if err != nil {
		if quoteConflict(status, rpcData) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "checkout price changed; request a new quote"})
			return
		}
		upstreamError(w, status, err)
		return
	}
	var reservation checkoutReservation
	if err := json.Unmarshal(rpcData, &reservation); err != nil || !validReservation(reservation) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "checkout reservation response was invalid"})
		return
	}
	if reservation.state() == "paid" {
		writeCheckoutReservation(w, http.StatusOK, reservation, "paid", "")
		return
	}
	if reservation.state() != "pending" {
		writeJSON(w, http.StatusConflict, map[string]string{"order_id": reservation.OrderID, "status": normalizeCheckoutStatus(reservation.state())})
		return
	}
	if reservation.SessionID == "" && !reservation.ExpiresAt.After(time.Now()) {
		result, _, err := s.serviceRPC(r.Context(), "expire_checkout_if_due", map[string]string{"p_order_id": reservation.OrderID})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "checkout expired but inventory cleanup is delayed"})
			return
		}
		writeJSON(w, http.StatusConflict, map[string]string{"order_id": reservation.OrderID, "status": normalizeCheckoutStatus(jsonScalarString(result))})
		return
	}
	var session checkoutSession
	if reservation.SessionID != "" {
		// Replaying the same user idempotency key reuses the existing provider session.
		session, err = s.retrieveCheckoutSession(r.Context(), reservation.SessionID, reservation.StripeAccountID)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not resume the existing payment session"})
			return
		}
		if !validSessionForReservation(session, reservation) {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment session did not match this order"})
			return
		}
		if session.Status == "expired" {
			_, _ = s.cancelUnpaidSession(r.Context(), reservation.OrderID, session.ID, reservation.StripeAccountID)
			writeJSON(w, http.StatusConflict, map[string]string{"order_id": reservation.OrderID, "status": "expired"})
			return
		}
		if session.Status == "complete" && session.PaymentStatus == "paid" {
			if err := s.finalizeFromProvider(r.Context(), reservation, session); err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment was received but order confirmation is delayed"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"order_id": reservation.OrderID, "status": "paid"})
			return
		}
		if session.Status != "open" || !validCheckoutURL(session.URL) {
			writeJSON(w, http.StatusConflict, map[string]string{"order_id": reservation.OrderID, "status": "pending"})
			return
		}
	} else {
		accountBody, accountStatus, accountErr := s.stripeRequest(r.Context(), http.MethodGet, "/v1/accounts/"+url.PathEscape(reservation.StripeAccountID), nil, "", "")
		var account connectAccount
		if accountErr != nil || json.Unmarshal(accountBody, &account) != nil || account.ID != reservation.StripeAccountID {
			stripeError(w, accountStatus, accountErr)
			return
		}
		if !account.ChargesEnabled || !account.PayoutsEnabled {
			_ = s.syncConnectReadiness(r.Context(), account)
			_, _, _ = s.serviceRPC(r.Context(), "fail_checkout_creation", map[string]string{"p_order_id": reservation.OrderID})
			writeJSON(w, http.StatusConflict, map[string]string{"order_id": reservation.OrderID, "status": "failed"})
			return
		}
		params := sessionParams(reservation, s.cfg.WebBaseURL)
		providerBody, providerStatus, providerErr := s.stripeRequest(r.Context(), http.MethodPost, "/v1/checkout/sessions", params, reservation.StripeAccountID, "cena-checkout-"+reservation.OrderID)
		if providerErr != nil {
			// A Stripe idempotency replay can return an error after a previous attempt
			// created a session. Keep the reservation and retry with the same key.
			stripeError(w, providerStatus, providerErr)
			return
		}
		if err := json.Unmarshal(providerBody, &session); err != nil || !validSessionForReservation(session, reservation) || session.Status != "open" || !validCheckoutURL(session.URL) {
			// Keep the reservation on malformed/ambiguous 2xx responses so an idempotent
			// retry can recover the exact provider session without releasing stock.
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe returned an invalid checkout session"})
			return
		}
	}
	if err := s.recordCheckoutSession(r.Context(), reservation, session); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not save checkout session; retry this request to resume payment"})
		return
	}
	writeCheckoutReservation(w, http.StatusOK, reservation, "", session.URL)
}

func quoteConflict(status int, body []byte) bool {
	if status == http.StatusConflict {
		return true
	}
	if status != http.StatusBadRequest && status != http.StatusUnprocessableEntity {
		return false
	}
	message := strings.ToLower(string(body))
	return strings.Contains(message, "quote changed") || strings.Contains(message, "amount changed")
}

func validReservation(v checkoutReservation) bool {
	return checkoutOrderIDPattern.MatchString(v.OrderID) && v.AmountCents > 0 && strings.EqualFold(v.Currency, "usd") &&
		v.ApplicationFeeCents >= 150 && v.ApplicationFeeCents <= 200 && v.ApplicationFeeCents <= v.AmountCents &&
		connectedAccountID.MatchString(v.StripeAccountID) && !v.ExpiresAt.IsZero() && validPromotionSnapshot(v)
}

func writeCheckoutReservation(w http.ResponseWriter, status int, v checkoutReservation, state, checkoutURL string) {
	response := map[string]any{
		"order_id": v.OrderID, "subtotal_cents": v.SubtotalCents, "discount_cents": v.DiscountCents,
		"amount_cents": v.AmountCents, "currency": strings.ToLower(v.Currency), "promo_code": v.PromoCode,
		"discount_percent": v.DiscountPercent,
	}
	if state != "" {
		response["status"] = state
	}
	if checkoutURL != "" {
		response["checkout_url"] = checkoutURL
	}
	writeJSON(w, status, response)
}

func sessionParams(v checkoutReservation, webBase string) url.Values {
	params := url.Values{}
	params.Set("mode", "payment")
	params.Set("payment_method_types[0]", "card")
	params.Set("client_reference_id", v.OrderID)
	params.Set("line_items[0][quantity]", "1")
	params.Set("line_items[0][price_data][currency]", "usd")
	params.Set("line_items[0][price_data][unit_amount]", strconv.Itoa(v.AmountCents))
	params.Set("line_items[0][price_data][product_data][name]", "Cena restaurant pickup order")
	params.Set("payment_intent_data[application_fee_amount]", strconv.Itoa(v.ApplicationFeeCents))
	params.Set("payment_intent_data[metadata][order_id]", v.OrderID)
	params.Set("payment_intent_data[metadata][cena_order_id]", v.OrderID)
	params.Set("metadata[order_id]", v.OrderID)
	params.Set("metadata[cena_order_id]", v.OrderID)
	params.Set("metadata[application_fee_cents]", strconv.Itoa(v.ApplicationFeeCents))
	params.Set("expires_at", strconv.FormatInt(v.ExpiresAt.Unix(), 10))
	params.Set("success_url", strings.TrimRight(webBase, "/")+"/checkout/success?order_id="+url.QueryEscape(v.OrderID)+"&session_id={CHECKOUT_SESSION_ID}")
	params.Set("cancel_url", strings.TrimRight(webBase, "/")+"/checkout/cancel?order_id="+url.QueryEscape(v.OrderID))
	return params
}

func validCheckoutURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "checkout.stripe.com" && parsed.User == nil && parsed.Path != ""
}

func validSessionForReservation(session checkoutSession, reservation checkoutReservation) bool {
	return validStripeSessionID(session.ID) && session.AmountTotal == reservation.AmountCents &&
		strings.EqualFold(session.Currency, reservation.Currency) && session.ClientReferenceID == reservation.OrderID &&
		session.Metadata["order_id"] == reservation.OrderID && session.Metadata["application_fee_cents"] == strconv.Itoa(reservation.ApplicationFeeCents) &&
		session.Metadata["cena_order_id"] == reservation.OrderID && session.ExpiresAt == reservation.ExpiresAt.Unix() &&
		len(session.PaymentMethodTypes) == 1 && session.PaymentMethodTypes[0] == "card"
}

func validStripeSessionID(id string) bool {
	if !strings.HasPrefix(id, "cs_") || len(id) <= 3 || len(id) > 255 {
		return false
	}
	for _, r := range id[3:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}

func (s *Server) recordCheckoutSession(ctx context.Context, reservation checkoutReservation, session checkoutSession) error {
	body, _ := json.Marshal(map[string]any{"p_order_id": reservation.OrderID, "p_session_id": session.ID, "p_checkout_url": session.URL,
		"p_stripe_account_id": reservation.StripeAccountID, "p_amount_cents": reservation.AmountCents, "p_application_fee_cents": reservation.ApplicationFeeCents,
		"p_expires_at": reservation.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	_, status, err := s.serviceRPC(ctx, "record_checkout_session", json.RawMessage(body))
	if err != nil {
		return fmt.Errorf("record checkout session: status %d", status)
	}
	return nil
}

func (s *Server) checkoutStatus(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedSupabaseUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !checkoutOrderIDPattern.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid order id"})
		return
	}
	data, status, err := s.serviceRPC(r.Context(), "get_checkout_for_owner", map[string]string{"p_order_id": id, "p_user_id": userID})
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	var checkout checkoutReservation
	if err := json.Unmarshal(data, &checkout); err != nil || !validReservation(checkout) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "checkout not found"})
		return
	}
	if checkout.state() != "pending" {
		writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(checkout.state())})
		return
	}
	if checkout.SessionID == "" {
		if !checkout.ExpiresAt.After(time.Now()) {
			result, _, err := s.serviceRPC(r.Context(), "expire_checkout_if_due", map[string]string{"p_order_id": checkout.OrderID})
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(jsonScalarString(result))})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
		return
	}
	session, err := s.retrieveCheckoutSession(r.Context(), checkout.SessionID, checkout.StripeAccountID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
		return
	}
	if !validSessionForReservation(session, checkout) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment session did not match this order"})
		return
	}
	switch {
	case session.Status == "complete" && session.PaymentStatus == "paid":
		if err := s.finalizeFromProvider(r.Context(), checkout, session); err != nil {
			writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "paid"})
	case session.Status == "expired":
		result, err := s.cancelUnpaidSession(r.Context(), checkout.OrderID, session.ID, checkout.StripeAccountID)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(result)})
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "pending"})
	}
}

func (s *Server) cancelCheckout(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.authenticatedSupabaseUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !checkoutOrderIDPattern.MatchString(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid order id"})
		return
	}
	data, status, err := s.serviceRPC(r.Context(), "get_checkout_for_owner", map[string]string{"p_order_id": id, "p_user_id": userID})
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	var checkout checkoutReservation
	if err := json.Unmarshal(data, &checkout); err != nil || !validReservation(checkout) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "checkout not found"})
		return
	}
	if checkout.state() != "pending" {
		writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(checkout.state())})
		return
	}
	if checkout.SessionID == "" {
		if checkout.ExpiresAt.After(time.Now()) {
			writeJSON(w, http.StatusConflict, map[string]string{"status": "pending"})
			return
		}
		result, _, err := s.serviceRPC(r.Context(), "expire_checkout_if_due", map[string]string{"p_order_id": checkout.OrderID})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not confirm checkout expiry"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(jsonScalarString(result))})
		return
	}
	params := url.Values{}
	_, _, _ = s.stripeRequest(r.Context(), http.MethodPost, "/v1/checkout/sessions/"+url.PathEscape(checkout.SessionID)+"/expire", params, checkout.StripeAccountID, "cena-expire-"+checkout.SessionID)
	// Stripe may return an error when the buyer already completed the session. Retrieve
	// it before deciding whether to cancel; a paid session must never release inventory.
	session, retrieveErr := s.retrieveCheckoutSession(r.Context(), checkout.SessionID, checkout.StripeAccountID)
	if retrieveErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not confirm Stripe checkout cancellation"})
		return
	}
	if !validSessionForReservation(session, checkout) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment session did not match this order"})
		return
	}
	if session.Status == "complete" && session.PaymentStatus == "paid" {
		if err := s.finalizeFromProvider(r.Context(), checkout, session); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment was received but order confirmation is delayed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "paid"})
		return
	}
	if session.Status != "expired" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe has not confirmed cancellation; keep this checkout pending"})
		return
	}
	result, err := s.cancelUnpaidSession(r.Context(), checkout.OrderID, session.ID, checkout.StripeAccountID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe expired this session but order cleanup is delayed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": normalizeCheckoutStatus(result)})
}

func normalizeCheckoutStatus(value string) string {
	switch value {
	case "paid":
		return "paid"
	case "refunded":
		return "refunded"
	case "expired", "cancelled", "canceled":
		return "expired"
	case "failed":
		return "failed"
	default:
		return "pending"
	}
}

func (s *Server) retrieveCheckoutSession(ctx context.Context, sessionID, accountID string) (checkoutSession, error) {
	if !validStripeSessionID(sessionID) {
		return checkoutSession{}, errors.New("invalid checkout session id")
	}
	body, _, err := s.stripeRequest(ctx, http.MethodGet, "/v1/checkout/sessions/"+url.PathEscape(sessionID), nil, accountID, "")
	if err != nil {
		return checkoutSession{}, err
	}
	var session checkoutSession
	if err := json.Unmarshal(body, &session); err != nil {
		return checkoutSession{}, err
	}
	return session, nil
}

func (s *Server) cancelUnpaidSession(ctx context.Context, orderID, sessionID, accountID string) (string, error) {
	body, status, err := s.serviceRPC(ctx, "cancel_checkout_if_unpaid", map[string]any{"p_order_id": orderID, "p_session_id": sessionID, "p_stripe_account_id": accountID})
	if err != nil {
		return "", fmt.Errorf("cancel unpaid checkout: status %d", status)
	}
	return jsonScalarString(body), nil
}

func (s *Server) finalizeFromProvider(ctx context.Context, reservation checkoutReservation, session checkoutSession) error {
	if session.Status != "complete" || session.PaymentStatus != "paid" {
		return errors.New("payment is not complete")
	}
	intent, err := s.retrieveAndVerifyPaymentIntent(ctx, reservation, session)
	if err != nil {
		return err
	}
	eventID := "reconcile_" + session.ID
	created := intent.LatestCharge.Created
	if created <= 0 {
		return errors.New("Stripe did not return a confirmed charge timestamp")
	}
	body, status, err := s.serviceRPC(ctx, "finalize_checkout_event", map[string]any{
		"p_event_id": eventID, "p_event_type": "checkout.session.completed", "p_order_id": reservation.OrderID, "p_session_id": session.ID,
		"p_stripe_account_id": reservation.StripeAccountID, "p_amount_total_cents": session.AmountTotal, "p_application_fee_cents": reservation.ApplicationFeeCents,
		"p_currency": session.Currency, "p_payment_status": session.PaymentStatus, "p_event_created_at": time.Unix(created, 0).UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return fmt.Errorf("reconcile paid checkout: status %d", status)
	}
	if normalizeCheckoutStatus(jsonScalarString(body)) != "paid" {
		return errors.New("payment is confirmed but order is not paid yet")
	}
	return nil
}

func (s *Server) retrieveAndVerifyPaymentIntent(ctx context.Context, reservation checkoutReservation, session checkoutSession) (stripePaymentIntent, error) {
	if !stripePaymentIntentPattern.MatchString(session.PaymentIntent) {
		return stripePaymentIntent{}, errors.New("missing PaymentIntent on paid Checkout Session")
	}
	params := url.Values{"expand[]": {"latest_charge"}}
	body, _, err := s.stripeRequest(ctx, http.MethodGet, "/v1/payment_intents/"+url.PathEscape(session.PaymentIntent), params, reservation.StripeAccountID, "")
	if err != nil {
		return stripePaymentIntent{}, errors.New("could not verify the paid PaymentIntent")
	}
	var intent stripePaymentIntent
	if err := json.Unmarshal(body, &intent); err != nil {
		return intent, errors.New("Stripe returned an invalid PaymentIntent")
	}
	if intent.ID != session.PaymentIntent || intent.Status != "succeeded" || intent.Amount != reservation.AmountCents || intent.AmountReceived != reservation.AmountCents ||
		!strings.EqualFold(intent.Currency, reservation.Currency) || intent.ApplicationFeeAmount != reservation.ApplicationFeeCents ||
		intent.Metadata["cena_order_id"] != reservation.OrderID || intent.Metadata["order_id"] != reservation.OrderID || intent.LatestCharge.Created <= 0 {
		return intent, errors.New("PaymentIntent does not match the reserved order and fee")
	}
	return intent, nil
}

func jsonScalarString(body []byte) string {
	var value string
	if json.Unmarshal(body, &value) == nil {
		return value
	}
	var object map[string]any
	if json.Unmarshal(body, &object) == nil {
		if status, ok := object["status"].(string); ok {
			return status
		}
		if status, ok := object["payment_status"].(string); ok {
			return status
		}
	}
	return ""
}

func (s *Server) serviceRPC(ctx context.Context, name string, body any) ([]byte, int, error) {
	key := strings.TrimSpace(s.cfg.SupabaseServiceRoleKey)
	if key == "" {
		return nil, http.StatusServiceUnavailable, errors.New("payment database operations are not configured")
	}
	params, err := json.Marshal(body)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	rpcCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(rpcCtx, http.MethodPost, s.cfg.SupabaseURL+"/rest/v1/rpc/"+name, strings.NewReader(string(params)))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	req.Header.Set("apikey", key)
	if !strings.HasPrefix(key, "sb_secret_") {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return data, resp.StatusCode, errors.New("privileged payment RPC failed")
	}
	return data, resp.StatusCode, nil
}

type stripeEvent struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Account string `json:"account"`
	Data    struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

func (s *Server) stripeWebhook(w http.ResponseWriter, r *http.Request) {
	if s.cfg.StripeWebhookSecret == "" || s.cfg.SupabaseServiceRoleKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "payment webhook is not configured"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, webhookBodyLimit)
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid webhook body"})
		return
	}
	if !verifyStripeSignature(r.Header.Get("Stripe-Signature"), body, s.cfg.StripeWebhookSecret, time.Now()) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Stripe signature"})
		return
	}
	var event stripeEvent
	if err := json.Unmarshal(body, &event); err != nil || event.ID == "" || event.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Stripe event"})
		return
	}
	if event.Type == "account.updated" {
		var account connectAccount
		if err := json.Unmarshal(event.Data.Object, &account); err != nil || !validConnectID(account.ID) || event.Account != "" && event.Account != account.ID {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid connected account event"})
			return
		}
		if err := s.syncConnectReadiness(r.Context(), account); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "could not save connected account readiness"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}
	if event.Type == "account.application.deauthorized" {
		if !validConnectID(event.Account) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "connected account context is required"})
			return
		}
		if err := s.syncConnectReadiness(r.Context(), connectAccount{ID: event.Account, ChargesEnabled: false, PayoutsEnabled: false}); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "could not disable disconnected account"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}
	if event.Type == "refund.created" || event.Type == "refund.updated" {
		if err := s.reconcileRefundEvent(r.Context(), event); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "refund event could not be applied; Stripe may retry"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}
	switch event.Type {
	case "checkout.session.completed", "checkout.session.expired", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed":
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}
	if !connectedAccountID.MatchString(event.Account) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Stripe Connect account context is required"})
		return
	}
	var session checkoutSession
	if err := json.Unmarshal(event.Data.Object, &session); err != nil || !validStripeSessionID(session.ID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Checkout Session event"})
		return
	}
	// Stripe Connect accounts can also emit sessions for other applications. Only
	// act on sessions carrying Cena's server-written marker; the DB still verifies
	// the recorded session/account/order tuple before changing any state.
	if session.Metadata["cena_order_id"] == "" {
		writeJSON(w, http.StatusOK, map[string]bool{"received": true})
		return
	}
	orderID := session.Metadata["cena_order_id"]
	fee, err := strconv.Atoi(session.Metadata["application_fee_cents"])
	if !checkoutOrderIDPattern.MatchString(orderID) || session.Metadata["order_id"] != orderID || err != nil || fee < 150 || fee > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Checkout Session metadata is invalid"})
		return
	}
	reservation := checkoutReservation{OrderID: orderID, AmountCents: session.AmountTotal, Currency: strings.ToLower(session.Currency), ApplicationFeeCents: fee, StripeAccountID: event.Account, SessionID: session.ID, ExpiresAt: time.Unix(session.ExpiresAt, 0).UTC(), Status: "pending"}
	chargeCreated := event.Created
	if (event.Type == "checkout.session.completed" || event.Type == "checkout.session.async_payment_succeeded") && session.PaymentStatus == "paid" {
		intent, intentErr := s.retrieveAndVerifyPaymentIntent(r.Context(), reservation, session)
		if intentErr != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Stripe payment could not be verified; Stripe may retry"})
			return
		}
		chargeCreated = intent.LatestCharge.Created
	}
	bodyData, status, err := s.serviceRPC(r.Context(), "finalize_checkout_event", map[string]any{
		"p_event_id": event.ID, "p_event_type": event.Type, "p_order_id": orderID, "p_session_id": session.ID, "p_stripe_account_id": event.Account,
		"p_amount_total_cents": session.AmountTotal, "p_application_fee_cents": fee, "p_currency": strings.ToLower(session.Currency),
		"p_payment_status": session.PaymentStatus, "p_event_created_at": time.Unix(chargeCreated, 0).UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		_ = status
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "payment event could not be applied; Stripe may retry"})
		return
	}
	_ = bodyData // The RPC is idempotent; Stripe only needs a successful acknowledgment.
	writeJSON(w, http.StatusOK, map[string]bool{"received": true})
}

func stripeError(w http.ResponseWriter, status int, _ error) {
	if status == 429 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "payment provider is busy; retry shortly"})
		return
	}
	if status == http.StatusConflict {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment provider state is uncertain; retry with the same idempotency key"})
		return
	}
	if status >= 400 && status < 500 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "payment provider rejected the checkout"})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "payment provider is unavailable"})
}
