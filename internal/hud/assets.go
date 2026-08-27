package hud

import (
	"embed"
	"encoding/base64"
	"strings"

	"github.com/alikwelyn/bigducks-live/internal/brand"
)

//go:embed assets/*
var assets embed.FS

func PageHTML() string {
	html, _ := assets.ReadFile("assets/index.html")
	style, _ := assets.ReadFile("assets/app.css")
	script, _ := assets.ReadFile("assets/app.js")
	page := strings.ReplaceAll(string(html), "{{STYLE}}", string(style))
	page = strings.ReplaceAll(page, "{{SCRIPT}}", string(script))
	return strings.ReplaceAll(page, "{{LOGO}}", base64.StdEncoding.EncodeToString(brand.LogoPNG()))
}
