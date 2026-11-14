package main

import (
	"log"
	"net/http"
	"os"
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
	cfg := api.Config{SupabaseURL: os.Getenv("SUPABASE_URL"), SupabaseAnonKey: os.Getenv("SUPABASE_ANON_KEY"), AllowedOrigins: allowedOrigins}
	if cfg.SupabaseURL == "" || cfg.SupabaseAnonKey == "" {
		log.Fatal("SUPABASE_URL and SUPABASE_ANON_KEY are required")
	}
	srv := &http.Server{Addr: ":" + port, Handler: api.New(cfg), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Printf("Cena API listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
