package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"
)

const checkoutReconcileBatchSize = 5
const checkoutReconcileLeaseSeconds = 300

type checkoutReconcileClaim struct {
	ClaimID string `json:"claim_id"`
	checkoutReservation
}

// RunCheckoutReconciler periodically recovers recorded sessions whose expiry webhook
// or customer status poll was missed. It never creates or expires Stripe sessions.
func (s *Server) RunCheckoutReconciler(ctx context.Context) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.reconcileDueCheckoutSessions(ctx); err != nil && ctx.Err() == nil {
			log.Printf("checkout reconciliation batch failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) reconcileDueCheckoutSessions(ctx context.Context) error {
	data, _, err := s.serviceRPC(ctx, "claim_due_checkout_reconciliations", map[string]int{
		"p_limit": checkoutReconcileBatchSize, "p_lease_seconds": checkoutReconcileLeaseSeconds,
	})
	if err != nil {
		return err
	}
	var claims []checkoutReconcileClaim
	if err := json.Unmarshal(data, &claims); err != nil {
		return err
	}
	for _, claim := range claims {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := s.reconcileClaim(ctx, claim); err != nil {
			log.Printf("checkout reconciliation item deferred")
		}
	}
	return nil
}

func (s *Server) reconcileClaim(ctx context.Context, claim checkoutReconcileClaim) error {
	r := claim.checkoutReservation
	if !checkoutOrderIDPattern.MatchString(claim.ClaimID) || !validReservation(r) ||
		!validStripeSessionID(r.SessionID) {
		return s.finishCheckoutReconciliation(ctx, claim, true)
	}
	session, err := s.retrieveCheckoutSession(ctx, r.SessionID, r.StripeAccountID)
	if err != nil || session.ID != r.SessionID || !validSessionForReservation(session, r) {
		return s.finishCheckoutReconciliation(ctx, claim, true)
	}
	switch {
	case session.Status == "complete" && session.PaymentStatus == "paid":
		if err := s.finalizeFromProvider(ctx, r, session); err != nil {
			return s.finishCheckoutReconciliation(ctx, claim, true)
		}
		return s.finishCheckoutReconciliation(ctx, claim, false)
	case session.Status == "expired" && session.PaymentStatus == "unpaid":
		body, status, err := s.serviceRPC(ctx, "release_expired_checkout", map[string]string{
			"p_order_id": r.OrderID, "p_expected_session_id": r.SessionID,
			"p_expected_account_id": r.StripeAccountID, "p_result": "expired",
		})
		if err != nil || status < 200 || status >= 300 {
			return s.finishCheckoutReconciliation(ctx, claim, true)
		}
		result := jsonScalarString(body)
		if result != "expired" && result != "paid" && result != "failed" && result != "cancelled" && result != "refunded" {
			return s.finishCheckoutReconciliation(ctx, claim, true)
		}
		return s.finishCheckoutReconciliation(ctx, claim, false)
	default:
		// Open, asynchronous, or unknown provider states stay reserved until a
		// later retrieval confirms a terminal outcome.
		return s.finishCheckoutReconciliation(ctx, claim, true)
	}
}

func (s *Server) finishCheckoutReconciliation(ctx context.Context, claim checkoutReconcileClaim, retry bool) error {
	if !checkoutOrderIDPattern.MatchString(claim.ClaimID) || !checkoutOrderIDPattern.MatchString(claim.OrderID) {
		return nil
	}
	body, status, err := s.serviceRPC(ctx, "finish_checkout_reconciliation", map[string]any{
		"p_order_id": claim.OrderID, "p_claim_id": claim.ClaimID, "p_retry": retry,
	})
	if err != nil || status < 200 || status >= 300 {
		if err != nil {
			return err
		}
		return errors.New("checkout reconciliation claim could not be finalized")
	}
	var finished bool
	if err := json.Unmarshal(body, &finished); err != nil || !finished {
		return errors.New("checkout reconciliation lease was lost")
	}
	return nil
}
