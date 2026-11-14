package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type restaurantPaymentAccount struct {
	RestaurantID string `json:"restaurant_id"`
	StripeID     string `json:"stripe_account_id"`
	FeeCents     int    `json:"application_fee_cents"`
}

type connectAccount struct {
	ID             string `json:"id"`
	ChargesEnabled bool   `json:"charges_enabled"`
	PayoutsEnabled bool   `json:"payouts_enabled"`
}

func (s *Server) registerConnectRoutes() {
	s.mux.HandleFunc("GET /v1/restaurants/{id}/payments", s.restaurantPayments)
	s.mux.HandleFunc("POST /v1/restaurants/{id}/stripe-onboarding", s.restaurantOnboarding)
}

func (s *Server) restaurantPayments(w http.ResponseWriter, r *http.Request) {
	if !s.allowPaymentManagement(w, r) {
		return
	}
	mapping, err := s.paymentAccount(r.Context(), r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load restaurant payment setup."})
		return
	}
	status := "not_connected"
	fee := s.connectFee()
	if mapping != nil {
		fee = mapping.FeeCents
		result, _, err := s.stripeRequest(r.Context(), http.MethodGet, "/v1/accounts/"+url.PathEscape(mapping.StripeID), nil, "", "")
		var account connectAccount
		if err != nil || json.Unmarshal(result, &account) != nil || account.ID != mapping.StripeID {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load the Stripe account."})
			return
		}
		if err := s.syncConnectReadiness(r.Context(), account); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not save Stripe account readiness."})
			return
		}
		status = "pending"
		if account.ChargesEnabled && account.PayoutsEnabled {
			status = "ready"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "application_fee_cents": fee})
}

func (s *Server) restaurantOnboarding(w http.ResponseWriter, r *http.Request) {
	if !s.allowPaymentManagement(w, r) {
		return
	}
	id := r.PathValue("id")
	mapping, err := s.paymentAccount(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load restaurant payment setup."})
		return
	}
	if mapping == nil {
		fields := url.Values{
			"country":                                {"US"},
			"controller[fees][payer]":                {"account"},
			"controller[losses][payments]":           {"stripe"},
			"controller[stripe_dashboard][type]":     {"full"},
			"capabilities[card_payments][requested]": {"true"},
			"metadata[cena_restaurant_id]":           {id},
		}
		result, _, err := s.stripeRequest(r.Context(), http.MethodPost, "/v1/accounts", fields, "", "cena-restaurant-"+id)
		var account connectAccount
		if err != nil || json.Unmarshal(result, &account) != nil || !validConnectID(account.ID) {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not open a Stripe account for this restaurant."})
			return
		}
		body, _ := json.Marshal(restaurantPaymentAccount{RestaurantID: id, StripeID: account.ID, FeeCents: s.connectFee()})
		if _, err := s.connectStorage(r.Context(), http.MethodPost, "?on_conflict=restaurant_id", body); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not save the connected account. Try again."})
			return
		}
		mapping, err = s.paymentAccount(r.Context(), id)
		if err != nil || mapping == nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load the connected account. Try again."})
			return
		}
	}
	base := strings.TrimRight(s.cfg.WebBaseURL, "/")
	fields := url.Values{
		"account": {mapping.StripeID}, "type": {"account_onboarding"},
		"return_url":  {base + "/restaurant/connect/return"},
		"refresh_url": {base + "/restaurant/connect/refresh"},
	}
	result, _, err := s.stripeRequest(r.Context(), http.MethodPost, "/v1/account_links", fields, "", "")
	var link struct {
		URL string `json:"url"`
	}
	if err != nil || json.Unmarshal(result, &link) != nil || !validAccountLink(link.URL) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Stripe could not start onboarding. Try again."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": link.URL})
}

func (s *Server) allowPaymentManagement(w http.ResponseWriter, r *http.Request) bool {
	if _, authorized := bearerToken(r); !authorized {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Sign in to manage payments."})
		return false
	}
	id := r.PathValue("id")
	if !isConnectUUID(id) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid restaurant ID."})
		return false
	}
	query := url.Values{"select": {"role"}, "restaurant_id": {"eq." + id}, "role": {"in.(owner,manager)"}}
	body, status, err := s.supabase(r, http.MethodGet, "/rest/v1/merchant_memberships?"+query.Encode(), nil)
	if err != nil {
		upstreamError(w, status, err)
		return false
	}
	var memberships []struct{ Role string }
	if err := json.Unmarshal(body, &memberships); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not confirm permission to manage payments."})
		return false
	}
	if len(memberships) == 0 || (memberships[0].Role != "owner" && memberships[0].Role != "manager") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Restaurant owners and managers can manage payments."})
		return false
	}
	base, err := url.Parse(s.cfg.WebBaseURL)
	if s.cfg.StripeSecretKey == "" || s.cfg.StripeWebhookSecret == "" || s.cfg.SupabaseServiceRoleKey == "" ||
		err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" ||
		(s.cfg.ApplicationFeeCents != 0 && (s.cfg.ApplicationFeeCents < 150 || s.cfg.ApplicationFeeCents > 200)) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Online payment setup is unavailable. Contact Cena."})
		return false
	}
	return true
}

func (s *Server) connectFee() int {
	if s.cfg.ApplicationFeeCents == 0 {
		return 175
	}
	return s.cfg.ApplicationFeeCents
}

func (s *Server) syncConnectReadiness(ctx context.Context, account connectAccount) error {
	if !validConnectID(account.ID) {
		return errors.New("invalid connected account ID")
	}
	query := url.Values{"stripe_account_id": {"eq." + account.ID}}
	body, _ := json.Marshal(map[string]any{
		"charges_enabled": account.ChargesEnabled,
		"payouts_enabled": account.PayoutsEnabled,
		"updated_at":      time.Now().UTC(),
	})
	_, err := s.connectStorage(ctx, http.MethodPatch, "?"+query.Encode(), body)
	return err
}

func (s *Server) paymentAccount(ctx context.Context, id string) (*restaurantPaymentAccount, error) {
	query := url.Values{"select": {"stripe_account_id,application_fee_cents"}, "restaurant_id": {"eq." + id}, "limit": {"1"}}
	body, err := s.connectStorage(ctx, http.MethodGet, "?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var entries []restaurantPaymentAccount
	if err := json.Unmarshal(body, &entries); err != nil || len(entries) > 1 {
		return nil, errors.New("invalid connected account record")
	}
	if len(entries) == 0 {
		return nil, nil
	}
	if !validConnectID(entries[0].StripeID) || entries[0].FeeCents < 150 || entries[0].FeeCents > 200 {
		return nil, errors.New("invalid connected account setup")
	}
	return &entries[0], nil
}

func (s *Server) connectStorage(parent context.Context, method, query string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, s.cfg.SupabaseURL+"/rest/v1/restaurant_payment_accounts"+query, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	key := s.cfg.SupabaseServiceRoleKey
	request.Header.Set("apikey", key)
	if !strings.HasPrefix(key, "sb_secret_") {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		if method == http.MethodPost {
			request.Header.Set("Prefer", "resolution=ignore-duplicates,return=minimal")
		} else {
			request.Header.Set("Prefer", "return=minimal")
		}
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, errors.New("connected account storage unavailable")
	}
	return io.ReadAll(io.LimitReader(response.Body, 65536))
}

func validAccountLink(value string) bool {
	link, err := url.Parse(value)
	return err == nil && link.Scheme == "https" && link.Host == "connect.stripe.com" && link.User == nil && link.Path != ""
}

func validConnectID(value string) bool {
	if !strings.HasPrefix(value, "acct_") || len(value) < 6 || len(value) > 100 {
		return false
	}
	for _, character := range value[len("acct_"):] {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}

func isConnectUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, character := range strings.ToLower(value) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if character != '-' {
				return false
			}
		} else if !(character >= 'a' && character <= 'f' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}
