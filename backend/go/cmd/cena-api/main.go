package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"cena/backend/go/internal/api"
)

func main() {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8080"
	}
	var allowedOrigins []string
	for _, origin := range strings.Split(os.Getenv("CORS_ALLOWED_ORIGINS"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowedOrigins = append(allowedOrigins, origin)
		}
	}
	feeCents := 175
	if value := strings.TrimSpace(os.Getenv("STRIPE_APPLICATION_FEE_CENTS")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			feeCents = parsed
		} else {
			log.Fatal("STRIPE_APPLICATION_FEE_CENTS must be an integer")
		}
	}
	cfg := api.Config{
		SupabaseURL: os.Getenv("SUPABASE_URL"), SupabaseAnonKey: os.Getenv("SUPABASE_ANON_KEY"),
		SupabaseServiceRoleKey: os.Getenv("SUPABASE_SERVICE_ROLE_KEY"), AllowedOrigins: allowedOrigins,
		StripeSecretKey: os.Getenv("STRIPE_SECRET_KEY"), StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
		StripeAPIBaseURL: os.Getenv("STRIPE_API_BASE_URL"), ApplicationFeeCents: feeCents, WebBaseURL: os.Getenv("CENA_WEB_BASE_URL"),
	}
	if cfg.SupabaseURL == "" || cfg.SupabaseAnonKey == "" {
		log.Fatal("SUPABASE_URL and SUPABASE_ANON_KEY are required")
	}
	srv := &http.Server{Addr: ":" + port, Handler: api.New(cfg), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Printf("Cena API listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
