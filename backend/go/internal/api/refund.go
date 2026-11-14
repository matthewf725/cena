package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

var stripePaymentIntentPattern = regexp.MustCompile(`^pi_[A-Za-z0-9]+$`)
var stripeRefundPattern = regexp.MustCompile(`^re_[A-Za-z0-9]+$`)

type stripeRefund struct {
	ID            string            `json:"id"`
	Status        string            `json:"status"`
	PaymentIntent string            `json:"payment_intent"`
	Currency      string            `json:"currency"`
	Amount        int               `json:"amount"`
	Metadata      map[string]string `json:"metadata"`
}

func refundStatus(status string) string {
	switch status {
	case "pending", "requires_action":
		return "pending"
	case "failed", "canceled":
		return "failed"
	case "succeeded":
		return "succeeded"
	default:
		return ""
	}
}

func (s *Server) registerRefundRoutes() {
	s.mux.HandleFunc("POST /v1/orders/{id}/refund", s.refundOrder)
}

func (s *Server) refundOrder(w http.ResponseWriter, r *http.Request) {
	userID, authenticated := s.authenticatedSupabaseUser(w, r)
	if !authenticated {
		return
	}
	orderID := r.PathValue("id")
	if !checkoutOrderIDPattern.MatchString(orderID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid order ID."})
		return
	}
	if !s.paymentConfigured() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Refunds are unavailable."})
		return
	}
	body, status, err := s.serviceRPC(r.Context(), "begin_checkout_refund", map[string]any{"p_user_id": userID, "p_order_id": orderID})
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	var refund struct {
		checkoutReservation
		Status   string `json:"status"`
		RefundID string `json:"refund_id"`
		Attempt  int    `json:"attempt"`
	}
	if err := json.Unmarshal(body, &refund); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not read the refund record."})
		return
	}
	if refund.Status == "refunded" {
		writeJSON(w, http.StatusOK, map[string]string{"status": "refunded"})
		return
	}
	if refund.Status != "pending" || refund.Attempt < 1 || refund.OrderID != orderID || !validReservation(refund.checkoutReservation) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not verify the refund record."})
		return
	}
	session, err := s.retrieveCheckoutSession(r.Context(), refund.SessionID, refund.StripeAccountID)
	if err != nil || session.ID != refund.SessionID || session.Status != "complete" || session.PaymentStatus != "paid" ||
		!validSessionForReservation(session, refund.checkoutReservation) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not verify the Stripe payment. Try again to resume the refund."})
		return
	}
	intentID := session.PaymentIntent
	if !stripePaymentIntentPattern.MatchString(intentID) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "The payment reference is missing. Contact Cena."})
		return
	}
	if _, err := s.retrieveAndVerifyPaymentIntent(r.Context(), refund.checkoutReservation, session); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not verify the Stripe charge for this refund. Try again."})
		return
	}
	if refund.RefundID != "" {
		if !stripeRefundPattern.MatchString(refund.RefundID) {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "The refund reference is invalid. Contact Cena."})
			return
		}
		body, status, err = s.stripeRequest(r.Context(), http.MethodGet, "/v1/refunds/"+refund.RefundID, nil, refund.StripeAccountID, "")
	} else {
		fields := url.Values{
			"payment_intent": {intentID}, "amount": {strconv.Itoa(refund.AmountCents)}, "refund_application_fee": {"true"},
			"metadata[cena_order_id]": {orderID}, "metadata[cena_refund_attempt]": {strconv.Itoa(refund.Attempt)},
		}
		body, status, err = s.stripeRequest(r.Context(), http.MethodPost, "/v1/refunds", fields,
			refund.StripeAccountID, "cena-refund-"+orderID+"-"+strconv.Itoa(refund.Attempt))
	}
	if err != nil {
		// Keep the attempt live so an ambiguous provider response can be retried with the same key.
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "5")
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe has not confirmed the refund. Retry to resume it."})
		return
	}
	var result stripeRefund
	if err := json.Unmarshal(body, &result); err != nil || !stripeRefundPattern.MatchString(result.ID) ||
		(refund.RefundID != "" && result.ID != refund.RefundID) || result.PaymentIntent != intentID ||
		result.Currency != "usd" || result.Amount != refund.AmountCents || result.Metadata["cena_order_id"] != orderID {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe returned a refund that did not match this order. Contact Cena."})
		return
	}
	if result.Status = refundStatus(result.Status); result.Status == "" {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe returned an unknown refund status."})
		return
	}
	body, status, err = s.serviceRPC(r.Context(), "record_checkout_refund", map[string]any{
		"p_order_id": orderID, "p_attempt": refund.Attempt, "p_refund_id": result.ID, "p_status": result.Status,
	})
	if err != nil {
		upstreamError(w, status, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": jsonScalarString(body)})
}

func (s *Server) reconcileRefundEvent(ctx context.Context, event stripeEvent) error {
	var refund stripeRefund
	if err := json.Unmarshal(event.Data.Object, &refund); err != nil {
		return err
	}
	orderID := refund.Metadata["cena_order_id"]
	attempt, _ := strconv.Atoi(refund.Metadata["cena_refund_attempt"])
	if orderID == "" || attempt == 0 {
		return nil
	}
	if !checkoutOrderIDPattern.MatchString(orderID) || !validConnectID(event.Account) || !stripeRefundPattern.MatchString(refund.ID) {
		return errors.New("invalid Stripe refund event")
	}
	body, _, err := s.serviceRPC(ctx, "checkout_refund_event_context", map[string]any{
		"p_order_id": orderID, "p_attempt": attempt, "p_account_id": event.Account,
	})
	if err != nil {
		return err
	}
	var current *struct {
		checkoutReservation
		RefundID string `json:"refund_id"`
	}
	if err := json.Unmarshal(body, &current); err != nil || current == nil {
		return err
	}
	// The POST records Stripe's refund ID. A webhook that arrives first can retry.
	if current.RefundID == "" {
		return errors.New("refund has not been linked yet")
	}
	if current.RefundID != refund.ID || current.Currency != refund.Currency || current.AmountCents != refund.Amount {
		return errors.New("refund does not match this order")
	}
	session, err := s.retrieveCheckoutSession(ctx, current.SessionID, event.Account)
	if err != nil || session.PaymentIntent != refund.PaymentIntent || !validSessionForReservation(session, current.checkoutReservation) {
		return errors.New("refund payment session does not match this order")
	}
	status := refundStatus(refund.Status)
	if status == "" {
		return errors.New("unknown refund status")
	}
	_, _, err = s.serviceRPC(ctx, "record_checkout_refund", map[string]any{
		"p_order_id": orderID, "p_attempt": attempt, "p_refund_id": refund.ID, "p_status": status,
	})
	return err
}
