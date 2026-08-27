# BIG DUCKS Desktop HUD Polish Design

## Goal

Deliver one fast, fixed-size BIG DUCKS window with a horizontal dashboard, reliable tray controls, automatic Windows startup interception, and a correctly branded Windows executable in the root `dist` directory.

## Approved interaction model

- The protection supervisor is a single instance.
- The HUD is also a single instance. Repeated requests activate the existing window instead of creating another WebView2 process.
- The tray menu contains exactly `Abrir`, `Reiniciar`, and `Sair`.
- Both left and right tray clicks expose the menu on Windows notification implementations that send either classic mouse messages or version-4 context-menu notifications.
- `Reiniciar` restarts only the protection core and preserves Discord.
- Windows startup remains owned by BIG DUCKS: its registry entry replaces Discord's direct startup entry, then BIG DUCKS starts protection before launching Discord.

## HUD layout

The window uses a fixed landscape size that fits a 1366×768 desktop. A full-width brand header sits above a two-column dashboard. Route status, metrics, recovery controls, and signed-update state occupy the left column; activity occupies the right. Technical details span the bottom. The document never scrolls and browser zoom gestures/shortcuts are blocked so the layout cannot drift.

The existing navy, cyan, green, and gold visual language remains. Controls retain visible keyboard focus, disabled/loading states, SVG icons, and reduced-motion support. Update checks start after first paint so the initial screen is responsive.

## Branding and packaging

The outer navy square is removed from the duck artwork while the framed duck remains the application mark. The same asset feeds the HUD, tray ICO, executable resources, taskbar, Start menu, and Explorer. The build script accepts an output directory so the tested artifact can be written directly to `D:\discord\dist\BigDucks.exe`.

## Verification

Automated tests cover exact tray labels, single-HUD arbitration, activation behavior, fixed landscape HUD markers, zoom prevention, delayed update work, transparent brand corners, startup registry ownership, and Windows resource generation. The final executable is built but not launched.
