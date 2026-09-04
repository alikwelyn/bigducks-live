package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/alikwelyn/bigducks-live/internal/logging"
	"github.com/alikwelyn/bigducks-live/internal/model"
)

var ErrDiscordClosed = errors.New("Discord is closed")

type recoveryPool interface {
	Snapshot() []model.VerifiedEndpoint
	Refresh(context.Context, bool) error
	PromoteReserve() bool
}

type recoveryTunnels interface {
	Generation() uint64
	CloseAll() int
	WaitForConnection(context.Context, uint64) error
}

type recoveryBridge interface {
	CloseConnections(context.Context) error
}

type RecoveryResult struct {
	State      RecoveryState
	Message    string
	UsedBridge bool
}

type RecoveryCoordinatorOptions struct {
	Pool          recoveryPool
	Tunnels       recoveryTunnels
	Bridge        recoveryBridge
	Status        *runtimeStatusStore
	Logger        *logging.Logger
	BridgeTimeout time.Duration
	DiscordAlive  func() bool
	StartDiscord  func(context.Context) error
	Aggressive    bool
	SecondStage   func(context.Context) error
}

type RecoveryCoordinator struct {
	pool          recoveryPool
	tunnels       recoveryTunnels
	bridge        recoveryBridge
	status        *runtimeStatusStore
	logger        *logging.Logger
	bridgeTimeout time.Duration
	discordAlive  func() bool
	startDiscord  func(context.Context) error
	aggressive    bool
	secondStage   func(context.Context) error
	gate          chan struct{}
}

func NewRecoveryCoordinator(options RecoveryCoordinatorOptions) *RecoveryCoordinator {
	bridgeTimeout := options.BridgeTimeout
	if bridgeTimeout <= 0 {
		bridgeTimeout = 3 * time.Second
	}
	return &RecoveryCoordinator{
		pool:          options.Pool,
		tunnels:       options.Tunnels,
		bridge:        options.Bridge,
		status:        options.Status,
		logger:        options.Logger,
		bridgeTimeout: bridgeTimeout,
		discordAlive:  options.DiscordAlive,
		startDiscord:  options.StartDiscord,
		aggressive:    options.Aggressive,
		secondStage:   options.SecondStage,
		gate:          make(chan struct{}, 1),
	}
}

func (c *RecoveryCoordinator) Recover(ctx context.Context) (RecoveryResult, error) {
	if c == nil || c.pool == nil || c.tunnels == nil {
		return RecoveryResult{State: RecoveryFailed}, ErrRuntimeUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case c.gate <- struct{}{}:
		defer func() { <-c.gate }()
	case <-ctx.Done():
		return RecoveryResult{State: RecoveryFailed}, ctx.Err()
	}

	if c.discordAlive != nil && !c.discordAlive() {
		if c.startDiscord == nil {
			c.setStatus(RecoveryDiscordClosed, ErrDiscordClosed.Error(), "O Discord está fechado")
			return RecoveryResult{State: RecoveryDiscordClosed, Message: "O Discord está fechado"}, ErrDiscordClosed
		}
		if err := c.startDiscord(ctx); err != nil {
			c.setStatus(RecoveryFailed, err.Error(), "Não foi possível abrir o Discord pela rota protegida")
			return RecoveryResult{State: RecoveryFailed, Message: "Não foi possível abrir o Discord pela rota protegida"}, err
		}
	}
	c.setStatus(RecoveryReconnecting, "", "Preparando uma nova rota para a live")
	if len(c.pool.Snapshot()) == 0 {
		if err := c.pool.Refresh(ctx, true); err != nil {
			c.setStatus(RecoveryNoProxy, err.Error(), "Nenhum proxy verificado está disponível")
			return RecoveryResult{State: RecoveryNoProxy, Message: "Nenhum proxy verificado está disponível"}, err
		}
	}

	before := c.tunnels.Generation()
	promoted := c.pool.PromoteReserve()
	closed := c.tunnels.CloseAll()
	if c.logger != nil {
		c.logger.Printf("gateway recovery started; promoted reserve: %t; closed %d tunnel(s)", promoted, closed)
	}

	usedBridge := false
	var bridgeErr error
	if c.bridge != nil {
		bridgeCtx, cancel := context.WithTimeout(ctx, c.bridgeTimeout)
		bridgeErr = c.bridge.CloseConnections(bridgeCtx)
		cancel()
		usedBridge = bridgeErr == nil
		if bridgeErr != nil && c.logger != nil {
			c.logger.Printf("Electron connection redial was unavailable: %v", bridgeErr)
		}
	}

	if err := c.tunnels.WaitForConnection(ctx, before); err != nil {
		message := "O Discord não abriu uma nova conexão de gateway dentro do prazo"
		technical := err.Error()
		if bridgeErr != nil {
			technical = fmt.Sprintf("%s; Electron redial: %v", technical, bridgeErr)
		}
		c.setStatus(RecoveryFailed, technical, message)
		return RecoveryResult{State: RecoveryFailed, Message: message, UsedBridge: usedBridge}, err
	}

	if c.aggressive && c.secondStage != nil {
		if err := c.secondStage(ctx); err != nil {
			message := "A rota foi trocada, mas a recuperação da mídia falhou"
			c.setStatus(RecoveryFailed, err.Error(), message)
			return RecoveryResult{State: RecoveryFailed, Message: message, UsedBridge: usedBridge}, err
		}
	}
	message := "A live está usando uma nova rota protegida"
	c.setStatus(RecoveryProtected, "", message)
	if c.logger != nil {
		c.logger.Printf("gateway recovery completed with a new protected tunnel")
	}
	return RecoveryResult{State: RecoveryProtected, Message: message, UsedBridge: usedBridge}, nil
}

func (c *RecoveryCoordinator) setStatus(state RecoveryState, technical, message string) {
	if c.status == nil {
		return
	}
	c.status.Update(func(status *RuntimeStatus) {
		status.State = state
		status.LastError = technical
		status.LastMessage = message
	})
}
