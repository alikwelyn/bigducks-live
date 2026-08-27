package controlapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/app"
)

type Client struct {
	control    ControlFile
	httpClient *http.Client
}

func LoadClient(path string) (*Client, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read core control file: %w", err)
	}
	var control ControlFile
	if err := json.Unmarshal(data, &control); err != nil {
		return nil, fmt.Errorf("decode core control file: %w", err)
	}
	if control.Address == "" || control.Token == "" {
		return nil, errors.New("core control file is incomplete")
	}
	return &Client{control: control, httpClient: &http.Client{Timeout: 25 * time.Second}}, nil
}

func (c *Client) Status(ctx context.Context) (app.RuntimeStatus, error) {
	var status app.RuntimeStatus
	err := c.request(ctx, http.MethodGet, "/v1/status", &status)
	return status, err
}

func (c *Client) Reconnect(ctx context.Context) error {
	return c.request(ctx, http.MethodPost, "/v1/reconnect", nil)
}
func (c *Client) Reload(ctx context.Context) error {
	return c.request(ctx, http.MethodPost, "/v1/reload", nil)
}
func (c *Client) TestRoute(ctx context.Context) error {
	return c.request(ctx, http.MethodPost, "/v1/test-route", nil)
}
func (c *Client) Shutdown(ctx context.Context) error {
	return c.request(ctx, http.MethodPost, "/v1/shutdown", nil)
}

func (c *Client) request(ctx context.Context, method, path string, target any) error {
	if c == nil || c.httpClient == nil {
		return errors.New("core control client is unavailable")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://"+c.control.Address+path, bytes.NewReader(nil))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.control.Token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var remote struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&remote)
		if remote.Error == "" {
			remote.Error = response.Status
		}
		return errors.New(remote.Error)
	}
	if target != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(target); err != nil {
			return err
		}
	}
	return nil
}
