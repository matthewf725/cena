package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const censusGeocoderEndpoint = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
const geocodeTimeout = 4 * time.Second
const maxAddressBytes = 500

type geocodeResponse struct {
	Label     string  `json:"label"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type censusResponse struct {
	Result struct {
		AddressMatches []struct {
			MatchedAddress string `json:"matchedAddress"`
			Coordinates    struct {
				X float64 `json:"x"`
				Y float64 `json:"y"`
			} `json:"coordinates"`
			AddressComponents struct {
				State string `json:"state"`
			} `json:"addressComponents"`
		} `json:"addressMatches"`
	} `json:"result"`
}

func (s *Server) geocode(w http.ResponseWriter, r *http.Request) {
	values, ok := r.URL.Query()["address"]
	if !ok || len(values) != 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "one address is required"})
		return
	}
	address := strings.TrimSpace(values[0])
	if len(address) < 8 || len(address) > maxAddressBytes || hasControlCharacters(address) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "enter a full US street address"})
		return
	}

	// Keep the address out of application logs and error responses. It is sent only to Census.
	ctx, cancel := context.WithTimeout(r.Context(), geocodeTimeout)
	defer cancel()
	endpoint, _ := url.Parse(censusGeocoderEndpoint)
	query := endpoint.Query()
	query.Set("address", address)
	query.Set("benchmark", "Public_AR_Current")
	query.Set("format", "json")
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "geocoder unavailable"})
		return
	}
	resp, err := s.geocoderClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "geocoder timed out"})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "geocoder unavailable"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "geocoder unavailable"})
		return
	}
	var result censusResponse
	dec := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	if err := dec.Decode(&result); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "invalid geocoder response"})
		return
	}
	if len(result.Result.AddressMatches) == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "address not found"})
		return
	}
	match := result.Result.AddressMatches[0]
	if !strings.EqualFold(strings.TrimSpace(match.AddressComponents.State), "CA") {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "pickup locations are currently limited to California"})
		return
	}
	if strings.TrimSpace(match.MatchedAddress) == "" || math.IsNaN(match.Coordinates.X) || math.IsInf(match.Coordinates.X, 0) ||
		math.IsNaN(match.Coordinates.Y) || math.IsInf(match.Coordinates.Y, 0) || match.Coordinates.X < -180 || match.Coordinates.X > 180 ||
		match.Coordinates.Y < -90 || match.Coordinates.Y > 90 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "invalid geocoder response"})
		return
	}
	writeJSON(w, http.StatusOK, geocodeResponse{
		Label: match.MatchedAddress, Latitude: match.Coordinates.Y, Longitude: match.Coordinates.X,
	})
}

func hasControlCharacters(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
