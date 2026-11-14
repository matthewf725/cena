package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var connectedAccountID = regexp.MustCompile(`^acct_[A-Za-z0-9]+$`)

func validateStripeAPIBaseURL(value, secret string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("invalid Stripe API base URL")
	}
	if value == "https://api.stripe.com" {
		return nil
	}
	ip := net.ParseIP(parsed.Hostname())
	loopback := strings.EqualFold(parsed.Hostname(), "localhost") || ip != nil && ip.IsLoopback()
	if !loopback || parsed.Scheme != "http" && parsed.Scheme != "https" || !strings.HasPrefix(secret, "sk_test_") {
		return errors.New("Stripe API override is allowed only on loopback with a sk_test_ key")
	}
	return nil
}

// stripeRequest performs a form-encoded Stripe API call. Tests inject a fake HTTP
// client and StripeAPIBaseURL; production always uses Stripe's API origin.
func (s *Server) stripeRequest(ctx context.Context, method, path string, params url.Values, stripeAccount, idempotencyKey string) ([]byte, int, error) {
	if strings.TrimSpace(s.cfg.StripeSecretKey) == "" {
		return nil, http.StatusServiceUnavailable, errors.New("Stripe is not configured")
	}
	if !strings.HasPrefix(path, "/v1/") || strings.Contains(path, "..") || strings.Contains(path, "?") || strings.Contains(path, "#") {
		return nil, http.StatusBadRequest, errors.New("invalid Stripe API path")
	}
	if stripeAccount != "" && !connectedAccountID.MatchString(stripeAccount) {
		return nil, http.StatusBadRequest, errors.New("invalid Stripe connected account")
	}
	endpoint := strings.TrimRight(s.cfg.StripeAPIBaseURL, "/") + path
	var body io.Reader
	if params != nil {
		if method == http.MethodGet || method == http.MethodDelete {
			parsed, parseErr := url.Parse(endpoint)
			if parseErr != nil {
				return nil, http.StatusBadRequest, parseErr
			}
			parsed.RawQuery = params.Encode()
			endpoint = parsed.String()
		} else {
			body = strings.NewReader(params.Encode())
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.StripeSecretKey)
	req.Header.Set("Accept", "application/json")
	if params != nil && method != http.MethodGet && method != http.MethodDelete {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if stripeAccount != "" {
		req.Header.Set("Stripe-Account", stripeAccount)
	}
	if idempotencyKey != "" {
		if len(idempotencyKey) > 255 || strings.ContainsAny(idempotencyKey, "\r\n") {
			return nil, http.StatusBadRequest, errors.New("invalid Stripe idempotency key")
		}
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	resp, err := s.stripeClient.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return data, resp.StatusCode, errors.New("Stripe request failed")
	}
	return data, resp.StatusCode, nil
}

// verifyStripeSignature validates Stripe's t=...,v1=... signature header and
// rejects signed payloads outside the five-minute replay window.
func verifyStripeSignature(header string, payload []byte, secret string, now time.Time) bool {
	if secret == "" || len(payload) == 0 {
		return false
	}
	var timestamp int64
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			parsed, err := strconv.ParseInt(value, 10, 64)
			if err != nil || timestamp != 0 {
				return false
			}
			timestamp = parsed
		case "v1":
			signatures = append(signatures, value)
		}
	}
	if timestamp == 0 || len(signatures) == 0 {
		return false
	}
	age := now.Sub(time.Unix(timestamp, 0))
	if age < -5*time.Minute || age > 5*time.Minute {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", timestamp)
	_, _ = mac.Write(payload)
	expected := mac.Sum(nil)
	for _, sig := range signatures {
		provided, err := hex.DecodeString(sig)
		if err == nil && hmac.Equal(expected, provided) {
			return true
		}
	}
	return false
}
